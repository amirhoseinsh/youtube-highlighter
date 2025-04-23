// ./lib/processor.js
import { downloadSubtitles } from "./srt-utils.js";
import { repunctuate } from "./repunctuate.js";
import { classifySentences } from "./question-classifier.js";
import { buildBlocks } from "./build-blocks.js";
import { scoreSegments } from "./groq-scorer.js";
import { downloadHighlights } from "./video-utils.js";

import fs from "fs-extra";
import path from "path";

/* ---------- helper: save master highlights SRT ---------- */
async function saveHighlightsSrt(list, outDir = "downloads") {
  if (!list.length) return;
  const blocks = list.map(
    (h, i) =>
      `${i + 1}\n${h.startTime},000 --> ${h.endTime},000\nScore ${h.score}\n`
  );
  const file = path.join(process.cwd(), outDir, `highlights_${Date.now()}.srt`);
  await fs.writeFile(file, blocks.join("\n"));
  console.log(`✅  Highlights SRT saved → ${file}`);
}

/* ------------------------- main ------------------------- */
export async function processVideo({ url, apiKey, numHighlights, minSeconds }) {
  /* 1. download & parse subtitles */
  console.log("⏬  downloading subtitles …");
  const { subtitles, savedSrtPath } = await downloadSubtitles(url);

  /* 2. re‑punctuate + sentence split */
  console.log("✏️   re‑punctuating …");
  const sentences = repunctuate(subtitles); // local

  /* 3. label each sentence Q / A / O */
  console.log("🔍  classifying Q/A/Other …");
  const cleanSentences = sentences.map((s) => ({
    ...s,
    text: s.text
      .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, "") // remove timecodes
      .replace(/<c>.*?<\/c>/g, "") // remove caption tags
      .trim(),
  }));
  const labeled = await classifySentences(cleanSentences, apiKey);

  /* 4. stitch Q→A blocks ≥ minSeconds */
  const blocks = buildBlocks(labeled, minSeconds, 5);
  console.log(`🧩  candidate blocks ≥${minSeconds}s: ${blocks.length}`);
  if (!blocks.length) throw new Error("No suitable Q→A blocks found.");

  /* 5. call Groq only to score each block */
  console.log("🏁  scoring blocks …");
  const scored = await scoreSegments(blocks, apiKey);

  /* 6. take top‑N (non‑overlap already ensured in buildBlocks) */
  const highlights = scored
    .slice(0, numHighlights)
    .map(({ startTime, endTime, score }) => ({ startTime, endTime, score }));

  if (highlights.length < numHighlights) {
    console.warn(
      `⚠️  Only ${highlights.length}/${numHighlights} scored blocks – lower ‑d or check labels.`
    );
  }

  await saveHighlightsSrt(highlights);
  console.log("🎬  downloading highlight videos …");
  await downloadHighlights(url, highlights, savedSrtPath, minSeconds);

  console.log("✅  done – all highlights processed.");
  return highlights;
}
