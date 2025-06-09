// lib/question-classifier.js  – improved Q/A/O labeller with parallel processing
// ------------------------------------------------------------------
//  * Labels a single **Q** line, then the **first** clear reply as **A**.
//  * Further lines revert to **O** unless they themselves look like Q.
//  * Greatly reduces false‑positive Q's and never produces an all‑A stream.
//  * Processes batches in parallel for improved performance
//  Public API unchanged.

import logger from "./logger.js";
import { createGroqClient, throttleApiCalls } from "./api-client.js";

/* ────────── rate limit tracking ────────── */
const TPM = 15_000;
const RPM = 30;
let rateLimit = {
  tokensAvailable: TPM,
  requestsAvailable: RPM,
  lastCallTimestamp: Date.now()
};

/* ────────── few‑shot prompt ────────── */
const FEW = `
Sentence: "Where did you grow up?"
Label: Q
Sentence: "I grew up in Chicago."
Label: A
Sentence: "That's interesting."
Label: O
Sentence: "Why do you think that happened?"
Label: Q
Sentence: "Because demand was higher than we expected."
Label: A`.trim();

/* ────────── heuristics ────────── */
const Q_MARK = /\?["']?\s*$/; // ends with ? — tolerate trailing quotes
const Q_PREFIX =
  /^(who|what|why|how|where|when|do|does|did|is|are|can|could|would|should|will|shall)\b/i;

function looksQuestion(txt) {
  return Q_MARK.test(txt) || (Q_PREFIX.test(txt) && txt.length < 120);
}

/**
 * Process a single batch of sentences for classification
 */
async function processBatch(batch, batchIndices, groq, model, batchNo, totalBatches) {
  try {
    const prompt = FEW + "\n" + batch.map((s) => `Sentence: \"${s.text}\"\nLabel:`).join("\n");
    const estTok = Math.ceil((FEW.length + batch.map(s => s.text).join("").length) / 4);
    
    // Apply rate limiting
    rateLimit = await throttleApiCalls(estTok, TPM, RPM, rateLimit);
    
    logger.info(`Processing batch ${batchNo}/${totalBatches} with ${batch.length} sentences`);

    const response = await groq.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: batch.length * 2,
      messages: [{ role: "user", content: prompt }],
    });

    const content = response.choices[0].message.content || "";
    const outputs = content
      .trim()
      .split(/\s+/)
      .filter((x) => /^[QAO]$/i.test(x));
      
    logger.debug(`Batch ${batchNo} results:`, { labels: outputs });
    
    // Return the results with their corresponding indices
    return {
      batchIndices,
      outputs
    };
  } catch (error) {
    logger.error(`Error processing batch ${batchNo}`, error);
    // Return empty results on error, will be handled by main function
    return {
      batchIndices,
      outputs: []
    };
  }
}

/* ────────── main ────────── */
export async function classifySentences(
  sentences,
  apiKey,
  retryOptions = {},
  progressCallback = null,
  model = "meta-llama/llama-4-maverick-17b-128e-instruct"
) {
  try {
    logger.info(`Classifying ${sentences.length} sentences using ${model}`);
    const labels = new Array(sentences.length).fill("O");

    // First pass: use heuristics for obvious questions and their answers
    for (let i = 0; i < sentences.length; i++) {
      const txt = sentences[i].text.trim();

      if (looksQuestion(txt)) {
        labels[i] = "Q";
        // mark the *first* following non‑Q line as A (if any)
        let j = i + 1;
        while (j < sentences.length && !sentences[j].text.trim()) j++; // skip empties
        if (j < sentences.length && !looksQuestion(sentences[j].text.trim())) {
          labels[j] = "A";
        }
      }
    }

    // Identify undecided sentences (still labeled as "O" and not immediately after Q)
    const undecidedIdx = labels
      .map((lab, idx) => (lab === "O" ? idx : null))
      .filter((idx) => idx !== null);

    if (!undecidedIdx.length) {
      logger.info("Sentence classification completed using heuristics only - no API calls needed");
      // Call progress callback if provided (complete in one step)
      if (typeof progressCallback === 'function') {
        progressCallback(sentences.length);
      }
      return sentences.map((s, i) => ({ ...s, label: labels[i] }));
    }

    // Second pass: use API for remaining undecided sentences with parallel processing
    logger.info(`Using AI to classify ${undecidedIdx.length} undecided sentences`);
    
    const groq = createGroqClient(apiKey, retryOptions);
    const BATCH_SIZE = 30; // Smaller batches for parallel processing
    const MAX_CONCURRENT = 3; // Maximum number of concurrent requests
    
    // Prepare batches
    const batches = [];
    let currentBatch = [];
    let currentBatchIndices = [];
    
    for (let i = 0; i < undecidedIdx.length; i++) {
      const idx = undecidedIdx[i];
      currentBatch.push(sentences[idx]);
      currentBatchIndices.push(idx);
      
      if (currentBatch.length >= BATCH_SIZE || i === undecidedIdx.length - 1) {
        batches.push({
          sentences: [...currentBatch],
          indices: [...currentBatchIndices]
        });
        currentBatch = [];
        currentBatchIndices = [];
      }
    }
    
    logger.info(`Created ${batches.length} batches for parallel processing`);
    
    // Process batches in parallel with limited concurrency
    let completedSentences = sentences.length - undecidedIdx.length; // Already classified by heuristics
    
    for (let i = 0; i < batches.length; i += MAX_CONCURRENT) {
      const batchPromises = [];
      
      // Create promises for a group of batches
      for (let j = 0; j < MAX_CONCURRENT && i + j < batches.length; j++) {
        const batchIdx = i + j;
        const { sentences: batchSentences, indices: batchIndices } = batches[batchIdx];
        
        batchPromises.push(
          processBatch(
            batchSentences, 
            batchIndices, 
            groq, 
            model, 
            batchIdx + 1, 
            batches.length
          )
        );
      }
      
      // Wait for this group of batches to complete
      const results = await Promise.all(batchPromises);
      
      // Process results
      for (const result of results) {
        const { batchIndices, outputs } = result;
        
        // Apply labels from this batch
        batchIndices.forEach((idx, k) => {
          if (outputs[k]) {
            labels[idx] = outputs[k];
          }
        });
        
        // Update progress
        completedSentences += batchIndices.length;
        if (typeof progressCallback === 'function') {
          progressCallback(completedSentences);
        }
      }
    }

    /* ensure any orphan Q has at least one A --------------------- */
    let orphanQCount = 0;
    for (let i = 0; i < labels.length - 1; i++) {
      if (labels[i] === "Q" && labels[i + 1] === "O") {
        labels[i + 1] = "A";
        orphanQCount++;
      }
    }
    
    if (orphanQCount > 0) {
      logger.debug(`Fixed ${orphanQCount} orphan questions by assigning an answer`);
    }

    // Count final label types
    const qCount = labels.filter(l => l === 'Q').length;
    const aCount = labels.filter(l => l === 'A').length;
    const oCount = labels.filter(l => l === 'O').length;
    
    logger.info(`Sentence classification complete`, {
      questions: qCount,
      answers: aCount,
      other: oCount,
      total: sentences.length
    });

    return sentences.map((s, i) => ({ ...s, label: labels[i] }));
  } catch (error) {
    logger.error("Error during sentence classification", error);
    
    // Fallback to basic heuristic-only classification in case of catastrophic failure
    logger.warn("Falling back to heuristic-only classification due to error");
    
    // Make sure we call the callback with completion
    if (typeof progressCallback === 'function') {
      progressCallback(sentences.length);
    }
    
    return sentences.map(s => ({ 
      ...s, 
      label: looksQuestion(s.text.trim()) ? "Q" : "O" 
    }));
  }
}
