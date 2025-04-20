// lib/build-blocks.js
import { hhmmssToSec, secToHhmmss } from "./time-utils.js";

/* heuristic: words that often start spoken questions -------- */
const Q_PREFIX =
  /^(who|what|why|how|where|when|do|does|did|is|are|can|could|would|should|will|shall|tell|give|explain)\b/i;

/**
 * Build non‑overlapping Q→A blocks lasting at least `minSeconds`.
 * @param {Array} labeled – items with {start,end,startTime,endTime,text,label}
 * @returns Array<{startTime,endTime,startMs,endMs,text}>
 */
export function buildBlocks(labeled, minSeconds, gapSec = 5) {
  /* 1️⃣  if Groq gave 0 Q lines, heuristically tag them  */
  if (!labeled.some((s) => s.label === "Q")) {
    console.warn("⚠️  0 questions from Groq – using heuristic labels");
    labeled.forEach((s, i) => {
      if (Q_PREFIX.test(s.text.trim())) s.label = "Q";
      else if (i && labeled[i - 1].label === "Q") s.label = "A";
      else s.label = "O";
    });
  }

  /* quick stats */
  const stats = { Q: 0, A: 0, O: 0 };
  labeled.forEach((s) => stats[s.label]++);
  console.log(
    `ℹ️  labeled sentences  Q:${stats.Q}  A:${stats.A}  O:${stats.O}`
  );

  /* 2️⃣  stitch from Q until **next real Q** (or 3‑min cap) */
  const blocks = [];
  for (let i = 0; i < labeled.length; i++) {
    if (labeled[i].label !== "Q") continue;
    const startIdx = i;
    let endIdx = i;

    // extend through every subsequent *non‑Q* line (A **or O**)
    // but cap each raw block at 3 minutes to avoid runaway
    while (
      endIdx + 1 < labeled.length &&
      labeled[endIdx + 1].label !== "Q" &&
      labeled[endIdx + 1].end - labeled[startIdx].start < 180_000
    ) {
      endIdx++;
    }

    const durSec = (labeled[endIdx].end - labeled[startIdx].start) / 1000;
    if (durSec < minSeconds) continue; // too short

    const slice = labeled.slice(startIdx, endIdx + 1);
    blocks.push({
      startMs: slice[0].start,
      endMs: slice.at(-1).end,
      text: slice.map((s) => s.text).join(" "),
    });

    i = endIdx; // skip past this block
  }
  /* 3️⃣  merge/neuter blocks that still touch
         (occasionally happens when Q‑lines are mis‑detected)          */
  blocks.sort((a, b) => a.startMs - b.startMs);
  const merged = [];
  for (const b of blocks) {
    const prev = merged.at(-1);
    if (prev && b.startMs - prev.endMs <= gapSec * 1000) {
      prev.endMs = Math.max(prev.endMs, b.endMs);
      prev.endTime = secToHhmmss(prev.endMs / 1000);
      prev.text += " " + b.text;
    } else {
      merged.push({
        ...b,
        startTime: secToHhmmss(b.startMs / 1000),
        endTime: secToHhmmss(b.endMs / 1000),
      });
    }
  }

  console.log(`🧩  candidate blocks ≥${minSeconds}s: ${blocks.length}`);
  return blocks;
}
