// lib/groq‑scorer.js  – token‑efficient, cache‑aware scoring
// -----------------------------------------------------------
//  API stays identical:  scoreSegments(blocks, apiKey) → blocks[] with { …, score }
//  so processor.js works without change.

import { Groq } from "groq-sdk";
import crypto from "crypto";
import fs from "fs-extra";
import path from "path";

/* ─────────── tunables ─────────── */
const MODEL = "meta-llama/llama-4-maverick-17b-128e-instruct";
const TOK_PER_CHAR = 0.25; // ≈4 chars / token
const MAX_CTX_TOK = 8_000; // keep well < 16 k ctx limit
const TPM = 15_000; // free‑tier bucket
const RPM = 30;
const CACHE_FILE = path.join(process.cwd(), ".score-cache.json");

/* ─────────── token/RPM bucket ─────────── */
let tokAvail = TPM,
  rpmAvail = RPM,
  last = Date.now();
async function throttle(need) {
  const now = Date.now(),
    ms = now - last;
  tokAvail = Math.min(TPM, tokAvail + (TPM * ms) / 60_000);
  rpmAvail = Math.min(RPM, rpmAvail + (RPM * ms) / 60_000);
  last = now;
  const wait = Math.max(
    need > tokAvail ? ((need - tokAvail) * 60_000) / TPM : 0,
    rpmAvail < 1 ? ((1 - rpmAvail) * 60_000) / RPM : 0
  );
  if (wait) {
    console.log(`⏳  score throttle ${Math.ceil(wait / 1000)} s`);
    await new Promise((r) => setTimeout(r, wait));
    return throttle(need);
  }
  tokAvail -= need;
  rpmAvail -= 1;
}

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

For each numbered segment below, output **one integer 1‑5** on the same line order, comma‑separated.  5 = extremely share‑worthy, 1 = poor.

Segments:
${list}

Reply with comma‑separated integers only. Example: 5,4,3`.trim();
}

/* ─────────── cache ─────────── */
let SCORE_DB = {};
try {
  SCORE_DB = await fs.readJson(CACHE_FILE);
} catch {}

function saveCache() {
  return fs.writeJson(CACHE_FILE, SCORE_DB, { spaces: 0 });
}

/* ─────────── main entry ─────────── */
export async function scoreSegments(blocks, apiKey) {
  if (!blocks.length) return [];
  const groq = new Groq({ apiKey });
  const scored = Array(blocks.length); // keep original order for later sort

  /* ---------- 1  fill from cache ----------------------- */
  const pending = [];
  blocks.forEach((seg, idx) => {
    const h = md5(seg.text);
    if (SCORE_DB[h]) {
      scored[idx] = { ...seg, score: SCORE_DB[h] };
    } else {
      pending.push({ seg, idx, hash: h });
    }
  });

  if (!pending.length) {
    console.log("🏁  all segment scores loaded from cache");
    return scored.sort((a, b) => b.score - a.score || a.startMs - b.startMs);
  }

  /* ---------- 2  call Groq in token‑bounded batches ---- */
  let batchNo = 0;
  for (let i = 0; i < pending.length; ) {
    let start = i,
      tok = 0;
    while (i < pending.length) {
      const add = batchPrompt([pending[i].seg]).length * TOK_PER_CHAR;
      if (tok + add > MAX_CTX_TOK) break;
      tok += add;
      i++;
    }
    const slice = pending.slice(start, i);
    batchNo++;
    console.log(
      `🔸  score batch ${batchNo} (${slice.length} seg, ${Math.ceil(tok)} tok)`
    );

    await throttle(Math.ceil(tok));

    const prompt = batchPrompt(slice.map((s) => s.seg));
    const res = await groq.chat.completions.create({
      model: MODEL,
      temperature: 0,
      max_tokens: slice.length * 2,
      messages: [{ role: "user", content: prompt }],
    });

    const nums = (res.choices[0].message.content || "")
      .trim()
      .split(/[^\d]+/) // split on non‑digits
      .filter(Boolean)
      .map(Number);

    slice.forEach(({ seg, idx, hash }, k) => {
      const n = Math.max(1, Math.min(nums[k] || 1, 5));
      SCORE_DB[hash] = n; // cache
      scored[idx] = { ...seg, score: n };
    });

    await saveCache(); // incremental safety – negligible I/O
  }

  console.log(
    `🏁  scoring done – ${pending.length}/${blocks.length} fetched from Groq`
  );
  return scored.sort((a, b) => b.score - a.score || a.startMs - b.startMs);
}
