// lib/groq‑scorer.js  – token‑efficient, cache‑aware scoring with parallel processing
// -----------------------------------------------------------
//  API stays identical:  scoreSegments(blocks, apiKey) → blocks[] with { …, score }
//  so processor.js works without change.

import crypto from "crypto";
import fs from "fs-extra";
import path from "path";
import logger from "./logger.js";
import { createGroqClient, throttleApiCalls } from "./api-client.js";

/* ─────────── tunables ─────────── */
const MODEL = "meta-llama/llama-4-maverick-17b-128e-instruct";
const TOK_PER_CHAR = 0.25; // ≈4 chars / token
const MAX_CTX_TOK = 8_000; // keep well < 16 k ctx limit
const TPM = 15_000; // free‑tier bucket
const RPM = 30;
const CACHE_FILE = path.join(process.cwd(), ".score-cache.json");
const MAX_CONCURRENT = 3; // Maximum number of concurrent API calls

/* ─────────── token/RPM tracking state ─────────── */
let rateLimit = {
  tokensAvailable: TPM,
  requestsAvailable: RPM,
  lastCallTimestamp: Date.now()
};

/* ─────────── helpers ─────────── */
function md5(str) {
  return crypto.createHash("md5").update(str).digest("hex");
}

function normalise(text, maxChars = 450) {
  let t = text.replace(/\s+/g, " ").trim();
  t = t.replace(/(?:^|\s)(>>?|[A-Z]+:)\s*/g, " "); // speaker tags
  t = t.replace(/\b(uh|um|erm|like)\b/gi, ""); // fillers
  t = t.replace(/\([^)]{0,80}\)/g, ""); // (laughs) etc.
  if (t.length > maxChars) t = t.slice(0, maxChars) + "…";
  return t.trim();
}

function batchPrompt(segments) {
  const list = segments
    .map((s, i) => `#${i + 1}  ${normalise(s.text)}`)
    .join("\n\n");

  return `You are a strict viral‑video editor.
Higher scores go to segments that (a) start abruptly, (b) finish on a punch‑line or cliff‑hanger, and (c) can stand alone outside the full talk.

For each numbered segment below, output **one integer 1‑5** on the same line order, comma‑separated.  5 = extremely share‑worthy, 1 = poor.

Segments:
${list}

Reply with comma‑separated integers only. Example: 5,4,3`.trim();
}

// Process a single batch of segments
async function processBatch(segments, segmentIndices, hashes, groq, batchNo, totalBatches) {
  try {
    const prompt = batchPrompt(segments);
    const estimatedTokens = Math.ceil(prompt.length * TOK_PER_CHAR);
    
    // Apply rate limiting
    rateLimit = await throttleApiCalls(estimatedTokens, TPM, RPM, rateLimit);
    
    logger.info(`Processing score batch ${batchNo}/${totalBatches} (${segments.length} segments, ${estimatedTokens} tokens)`);
    
    const res = await groq.chat.completions.create({
      model: MODEL,
      temperature: 0,
      max_tokens: segments.length * 2,
      messages: [{ role: "user", content: prompt }],
    });

    const nums = (res.choices[0].message.content || "")
      .trim()
      .split(/[^\d]+/) // split on non‑digits
      .filter(Boolean)
      .map(Number);
      
    logger.debug(`Received scores for batch ${batchNo}`, { scores: nums });

    if (nums.length !== segments.length) {
      logger.warn(`Score count mismatch: received ${nums.length} scores for ${segments.length} segments`, {
        received: nums,
        expected: segments.length
      });
    }
    
    // Return results with indices and scores
    return {
      segmentIndices,
      hashes,
      scores: nums.map(n => Math.max(1, Math.min(n || 1, 5)))
    };
  } catch (err) {
    logger.error(`Failed to score batch ${batchNo}`, err);
    
    // Return default scores for failed batch
    return {
      segmentIndices, 
      hashes,
      scores: Array(segments.length).fill(1)
    };
  }
}

/* ─────────── cache ─────────── */
let SCORE_DB = {};
try {
  SCORE_DB = await fs.readJson(CACHE_FILE);
  logger.debug(`Loaded score cache with ${Object.keys(SCORE_DB).length} entries`);
} catch (err) {
  logger.debug(`No existing score cache found or error loading cache`, err);
  SCORE_DB = {};
}

async function saveCache() {
  try {
    await fs.writeJson(CACHE_FILE, SCORE_DB, { spaces: 0 });
    logger.debug(`Saved score cache with ${Object.keys(SCORE_DB).length} entries`);
    return true;
  } catch (err) {
    logger.warn(`Failed to save score cache`, err);
    return false;
  }
}

/* ─────────── main entry ─────────── */
export async function scoreSegments(blocks, apiKey, retryOptions = {}, progressCallback = null) {
  try {
    if (!blocks.length) return [];
    
    logger.info(`Scoring ${blocks.length} segments using ${MODEL}`);
    
    const groq = createGroqClient(apiKey, retryOptions);
    const scored = Array(blocks.length); // keep original order for later sort

    /* ---------- 1  fill from cache ----------------------- */
    const pending = [];
    let completedCount = 0;
    
    blocks.forEach((seg, idx) => {
      const h = md5(seg.text);
      if (SCORE_DB[h]) {
        scored[idx] = { ...seg, score: SCORE_DB[h] };
        logger.debug(`Segment ${idx+1} score loaded from cache: ${SCORE_DB[h]}`);
        completedCount++;
      } else {
        pending.push({ seg, idx, hash: h });
      }
    });
    
    // Update progress if callback provided
    if (typeof progressCallback === 'function') {
      progressCallback(completedCount);
    }

    if (!pending.length) {
      logger.info("All segment scores loaded from cache");
      return scored.sort((a, b) => b.score - a.score || a.startMs - b.startMs);
    }

    /* ---------- 2  call Groq in parallel batches with token boundaries ---- */
    // Create optimally sized batches
    const batches = [];
    let currentBatch = [];
    let currentIndices = [];
    let currentHashes = [];
    let batchTokens = 0;
    
    for (let i = 0; i < pending.length; i++) {
      const { seg, idx, hash } = pending[i];
      const segmentTokens = seg.text.length * TOK_PER_CHAR;
      
      // If adding this segment would exceed token limit, finalize the batch
      if (currentBatch.length > 0 && batchTokens + segmentTokens > MAX_CTX_TOK / 2) {
        batches.push({
          segments: [...currentBatch],
          indices: [...currentIndices],
          hashes: [...currentHashes]
        });
        
        // Reset for next batch
        currentBatch = [];
        currentIndices = [];
        currentHashes = [];
        batchTokens = 0;
      }
      
      // Add segment to current batch
      currentBatch.push(seg);
      currentIndices.push(idx);
      currentHashes.push(hash);
      batchTokens += segmentTokens;
    }
    
    // Add the final batch if not empty
    if (currentBatch.length > 0) {
      batches.push({
        segments: currentBatch,
        indices: currentIndices,
        hashes: currentHashes
      });
    }
    
    logger.info(`Created ${batches.length} batches for parallel scoring`);
    
    // Process batches in parallel with limited concurrency
    for (let i = 0; i < batches.length; i += MAX_CONCURRENT) {
      const batchPromises = [];
      
      // Create promises for a group of batches
      for (let j = 0; j < MAX_CONCURRENT && i + j < batches.length; j++) {
        const batchIdx = i + j;
        const { segments, indices, hashes } = batches[batchIdx];
        
        batchPromises.push(
          processBatch(
            segments,
            indices,
            hashes,
            groq,
            batchIdx + 1,
            batches.length
          )
        );
      }
      
      // Wait for this group of batches to complete
      const results = await Promise.all(batchPromises);
      
      // Process results and update cache
      for (const result of results) {
        const { segmentIndices, hashes, scores } = result;
        
        segmentIndices.forEach((idx, k) => {
          // Apply score and update cache
          const score = scores[k] || 1;
          SCORE_DB[hashes[k]] = score;
          scored[idx] = { ...pending[idx].seg, score };
        });
        
        // Update progress
        completedCount += segmentIndices.length;
        if (typeof progressCallback === 'function') {
          progressCallback(completedCount);
        }
      }
      
      // Save cache incrementally for resilience
      await saveCache();
    }

    logger.info(`Scoring complete - ${pending.length}/${blocks.length} fetched from Groq`);
    return scored.sort((a, b) => b.score - a.score || a.startMs - b.startMs);
  } catch (err) {
    logger.error("Failed to score segments", err);
    
    // Call progress callback with completion if provided (error case)
    if (typeof progressCallback === 'function') {
      progressCallback(blocks.length);
    }
    
    // Return blocks with default scores instead of failing completely
    return blocks.map(seg => ({ ...seg, score: 1 }))
      .sort((a, b) => a.startMs - b.startMs);
  }
}
