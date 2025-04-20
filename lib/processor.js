// ./lib/processor.js
//------------------------------------------------------------
//  end‑to‑end “find + score + download”
//------------------------------------------------------------
import { downloadSubtitles } from "./srt-utils.js";
import { downloadHighlights } from "./video-utils.js";

import {
  repunctuate,
  markQuestions,
  buildWindows,
  scoreWindows,
  pickTop,
} from "./highlighter/index.js";

import fs from "fs-extra";
import path from "path";

/*───────────────────────────────────────────────────────────*/
/* helper ▸ save one master SRT listing every highlight      */
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
/*───────────────────────────────────────────────────────────*/
/* main export                                               */
export async function processVideo({
  url,
  apiKey,
  numHighlights, // ‑n    (int)
  minSeconds, // ‑d * 60  already converted in main.js
}) {
  /* 1.  subtitles -------------------------------------------------------- */
  console.log("⏬  downloading subtitles …");
  const { subtitles, savedSrtPath } = await downloadSubtitles(url);

  /* 2.  sentence‑level text -------------------------------------------- */
  console.log("✏️   re‑punctuating …");
  const sentences = repunctuate(subtitles); // local JS fallback

  /* 3.  mark questions heuristically ----------------------------------- */
  const marked = markQuestions(sentences);

  /* 4.  build Q→A windows (≤3 min) ------------------------------------- */
  const windows = buildWindows(marked);
  console.log(`🧩  candidate windows: ${windows.length}`);
  if (!windows.length) throw new Error("No question‑answer windows detected.");

  /* 5.  score each window with Groq ------------------------------------ */
  console.log("🏁  scoring windows …");
  const scored = await scoreWindows(windows, apiKey);
  console.log(`🏁  scoring done – ${scored.length} segments scored`);

  /* 6.  pick top‑N non‑overlapping highlights -------------------------- */
  const highlights = pickTop(scored, numHighlights, minSeconds * 1000);
  console.log(
    `🏆  picked ${highlights.length}/${numHighlights} highlights (≥${minSeconds}s)`
  );

  /* 7.  persist SRT + download video clips ----------------------------- */
  await saveHighlightsSrt(highlights);
  console.log("🎬  downloading highlight videos …");
  await downloadHighlights(url, highlights, savedSrtPath, minSeconds);

  console.log("✅  done – all highlights processed.");
  return highlights;
}
