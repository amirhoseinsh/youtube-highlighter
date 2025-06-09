// lib/build-blocks.js
import { hhmmssToSec, secToHhmmss } from "./time-utils.js";
import logger from "./logger.js";

/* heuristic: words that often start spoken questions -------- */
const Q_PREFIX =
  /^(who|what|why|how|where|when|do|does|did|is|are|can|could|would|should|will|shall|tell|give|explain)\b/i;

// Estimate tokens in a text block - rough approximation (4 chars per token)
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Build non‑overlapping Q→A blocks lasting at least `minSeconds`,
 * with optimized token usage.
 * @param {Array} labeled – items with {start,end,startTime,endTime,text,label}
 * @param {number} minSeconds - Minimum duration in seconds
 * @param {number} gapSec - Gap between blocks in seconds
 * @param {number} maxTokensPerBlock - Maximum tokens per block (defaults to 1024)
 * @returns Array<{startTime,endTime,startMs,endMs,text}>
 */
export function buildBlocks(labeled, minSeconds, gapSec = 5, maxTokensPerBlock = 1024) {
  /* 1️⃣  if Groq gave 0 Q lines, heuristically tag them  */
  if (!labeled.some((s) => s.label === "Q")) {
    logger.warn("No questions found in labeled data - applying heuristic labels");
    labeled.forEach((s, i) => {
      if (Q_PREFIX.test(s.text.trim())) s.label = "Q";
      else if (i && labeled[i - 1].label === "Q") s.label = "A";
      else s.label = "O";
    });
  }

  /* quick stats */
  const stats = { Q: 0, A: 0, O: 0 };
  labeled.forEach((s) => stats[s.label]++);
  logger.info("Labeled sentence statistics", stats);

  /* 2️⃣  stitch from Q until **next real Q** or token/time limit is reached */
  const blocks = [];
  for (let i = 0; i < labeled.length; i++) {
    if (labeled[i].label !== "Q") continue;
    const startIdx = i;
    let endIdx = i;
    let totalTokens = estimateTokens(labeled[i].text);
    let totalDuration = (labeled[i].end - labeled[i].start) / 1000;

    // extend through subsequent lines with token and duration awareness
    while (
      endIdx + 1 < labeled.length && 
      // Don't go past the next question
      labeled[endIdx + 1].label !== "Q" &&
      // Don't exceed maximum duration (3 minutes)
      labeled[endIdx + 1].end - labeled[startIdx].start < 180_000 &&
      // Check token limit (add some buffer)
      totalTokens + estimateTokens(labeled[endIdx + 1].text) <= maxTokensPerBlock - 50
    ) {
      endIdx++;
      totalTokens += estimateTokens(labeled[endIdx].text);
      totalDuration = (labeled[endIdx].end - labeled[startIdx].start) / 1000;
    }

    // If we didn't reach minimum duration but reached token limit, we'll try to be more selective
    if (totalDuration < minSeconds && totalTokens >= maxTokensPerBlock / 2) {
      // Prioritize keeping the core Q&A pair, trimming "O" labeled content
      const slice = labeled.slice(startIdx, endIdx + 1);
      
      // Find the last "A" labeled sentence
      const lastAnswerIdx = slice.map(s => s.label).lastIndexOf("A");
      if (lastAnswerIdx > 0 && lastAnswerIdx < slice.length - 1) {
        // Keep up to the last answer plus one additional context sentence if available
        endIdx = startIdx + lastAnswerIdx + 1;
        totalDuration = (labeled[endIdx].end - labeled[startIdx].start) / 1000;
        totalTokens = slice.slice(0, lastAnswerIdx + 2).reduce((sum, s) => sum + estimateTokens(s.text), 0);
        
        logger.debug(`Trimmed block to Q&A core: ${labeled[startIdx].startTime} - ${labeled[endIdx].endTime}, tokens: ${totalTokens}`);
      }
    }

    if (totalDuration < minSeconds) {
      logger.debug(`Block at ${labeled[startIdx].startTime} too short (${totalDuration.toFixed(1)}s < ${minSeconds}s), skipping`);
      continue; // too short
    }

    const slice = labeled.slice(startIdx, endIdx + 1);
    blocks.push({
      startMs: slice[0].start,
      endMs: slice.at(-1).end,
      startTime: slice[0].startTime,
      endTime: slice.at(-1).endTime,
      text: slice.map((s) => s.text).join(" "),
      estimatedTokens: totalTokens
    });

    logger.debug(`Created block: ${slice[0].startTime} - ${slice.at(-1).endTime}, duration: ${totalDuration.toFixed(1)}s, tokens: ${totalTokens}`);
    i = endIdx; // skip past this block
  }

  logger.info(`Created ${blocks.length} optimized blocks with min duration ${minSeconds}s and max tokens ${maxTokensPerBlock}`);
  
  // Add token usage stats
  if (blocks.length > 0) {
    const avgTokens = blocks.reduce((sum, block) => sum + block.estimatedTokens, 0) / blocks.length;
    const maxUsed = Math.max(...blocks.map(block => block.estimatedTokens));
    logger.info(`Block token usage stats: avg=${Math.round(avgTokens)}, max=${maxUsed}`);
  }
  
  return blocks;
}
