// lib/groq-api.js  – gemma2‑9b‑it, fast, overlap‑aware, fallback
import { Groq } from "groq-sdk";
import { setTimeout } from "timers/promises";

/* ── helpers ─────────────────────────────────────────────── */
const hhmmssToSec = (ts) =>
  ts
    .split(/[:,]/)
    .reduce((t, v, i, a) => t + +v * [3600, 60, 1, 0.001][i + 4 - a.length], 0);

const secToHhmmss = (s) =>
  [3600, 60, 1]
    .map((d) =>
      String(Math.floor(s / d) % (d === 1 ? 60 : 60)).padStart(2, "0")
    )
    .join(":");

const fmtChunk = (subs) =>
  subs.map((s) => `[${s.startTime} - ${s.endTime}] ${s.text}`).join("\n");

/* ── config (gemma2 free tier) ───────────────────────────── */
const MODEL = "meta-llama/llama-4-maverick-17b-128e-instruct";
const TARGET_TOK = 2900; // ~5 calls/min × 3k ≈ 15 k TPM
const CHUNK_MIN_LINE = 20;
const OVERLAP_LINES = 30;

const TPM_LIMIT = 15000;
const RPM_LIMIT = 30;
const SAFE_CTX = 10000; // gemma2 context

/* ── token & RPM bucket ─────────────────────────────────── */
let tokAvail = TPM_LIMIT,
  rpmAvail = RPM_LIMIT,
  lastRef = Date.now();
async function throttle(toks) {
  const now = Date.now(),
    ms = now - lastRef;
  tokAvail = Math.min(TPM_LIMIT, tokAvail + (TPM_LIMIT * ms) / 60000);
  rpmAvail = Math.min(RPM_LIMIT, rpmAvail + (RPM_LIMIT * ms) / 60000);
  lastRef = now;
  const needTok = toks - tokAvail,
    needReq = 1 - rpmAvail;
  if (needTok > 0 || needReq > 0) {
    const wait = Math.max(
      needTok > 0 ? (needTok * 60000) / TPM_LIMIT : 0,
      needReq > 0 ? (needReq * 60000) / RPM_LIMIT : 0
    );
    console.log(`⏳  Waiting ${Math.ceil(wait / 1000)} s (bucket refill)`);
    await setTimeout(wait);
    return throttle(toks);
  }
  tokAvail -= toks;
  rpmAvail -= 1;
}

/* ── chunking ───────────────────────────────────────────── */
const estTokPerLine = (subs) => {
  const sample = subs
    .slice(0, 40)
    .map((s) => s.text)
    .join("");
  return Math.max(1, Math.ceil((sample.length * 0.22) / 40)); // gemma2 avg 4.5 char/tok
};
const buildChunks = (subs) => {
  const base = Math.max(20, Math.floor(TARGET_TOK / estTokPerLine(subs)));
  const out = [];
  for (let i = 0; i < subs.length; ) {
    out.push(subs.slice(i, i + base));
    i += base - OVERLAP_LINES;
  }
  return out;
};

/* ── main export ─────────────────────────────────────────── */
export async function analyzeWithGroq(
  subs,
  _prompt,
  apiKey,
  N = 5,
  minSeconds = 60,
  ctxLimit = SAFE_CTX
) {
  if (!subs?.length) throw new Error("Subtitle data empty.");
  if (!apiKey) throw new Error("Groq API key missing.");

  console.log(`🚀  Extracting ${N} highlights ≥${minSeconds}s using ${MODEL}`);
  const groq = new Groq({ apiKey });
  const chunks = buildChunks(subs);
  const found = [];

  const sysPrompt = `
Start reading **after** the first line that ends in "?" or ":" (skip music / host intro).

Find segments where:
  • A question is spoken.
  • The immediate answer (and any one‑sentence follow‑up) ends the segment.
The final segment must last **≥${minSeconds}s**.

Rate each segment 1‑5 for (a) educational insight and (b) virality (5 = best).

Return only JSON, sorted by score desc:
{"startTime":"HH:MM:SS","endTime":"HH:MM:SS","score":<1-5>}
`.trim();

  /* recursive slice runner */
  async function run(slice) {
    const text = fmtChunk(slice);
    const estTok = Math.ceil((sysPrompt.length + text.length) * 0.28);
    if (estTok > ctxLimit && slice.length > CHUNK_MIN_LINE) {
      const mid = Math.ceil(slice.length / 2);
      return [
        ...(await run(slice.slice(0, mid))),
        ...(await run(slice.slice(mid))),
      ];
    }
    await throttle(estTok);
    console.log(
      `🔸  Groq (${estTok} tok) 🪣 ${Math.floor(tokAvail)}/${TPM_LIMIT}`
    );
    let res
    try {
      res = await groq.chat.completions.create({
        model: MODEL,
        temperature: 0.1,
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: text },
        ],
      });
    } catch (err) {
      if (
        err?.response?.data?.error?.code === "context_length_exceeded" &&
        slice.length > CHUNK_MIN_LINE
      ) {
        console.warn("⚠️  ctx overflow – splitting this slice in half");
        const mid = Math.ceil(slice.length / 2);
        return [
          ...(await run(slice.slice(0, mid))),
          ...(await run(slice.slice(mid))),
        ];
      }
      throw err; // other errors propagate
    }
    const objs =
      (res.choices[0].message.content || "").match(/\{[^}]*\}/g) || [];
    return objs.flatMap((j) => {
      try {
        const o = JSON.parse(j);
        if (
          typeof o.score === "number" &&
          /^\d{2}:\d{2}:\d{2}$/.test(o.startTime) &&
          /^\d{2}:\d{2}:\d{2}$/.test(o.endTime)
        ) {
          const s = hhmmssToSec(o.startTime),
            e = hhmmssToSec(o.endTime);
          if (e - s >= minSeconds)
            return [{ ...o, startSeconds: s, endSeconds: e }];
        }
      } catch {}
      return [];
    });
  }

  /* gather */
  for (let i = 0; i < chunks.length; i++) {
    console.log(
      `📄  Chunk ${i + 1}/${chunks.length} (${chunks[i].length} lines)`
    );
    found.push(...(await run(chunks[i])));
  }
  console.log(`🔍  Candidates ≥${minSeconds}s: ${found.length}`);

  /* score sort then earliest */
  found.sort((a, b) => b.score - a.score || a.startSeconds - b.startSeconds);

  /* pick non‑overlapping w/ 2 s margin */
  const margin = 2,
    pick = [],
    clash = (a, b) =>
      !(
        a.endSeconds + margin < b.startSeconds - margin ||
        b.endSeconds + margin < a.startSeconds - margin
      );

  for (const seg of found) {
    if (pick.length === N) break;
    if (pick.every((p) => !clash(p, seg))) pick.push(seg);
  }

  /* fallback */
  if (pick.length < N) {
    console.log(`⚠️  Only ${pick.length}/${N} long non‑overlapping – filling.`);
    for (const seg of found) {
      if (pick.length === N) break;
      if (!pick.includes(seg)) pick.push(seg);
    }
  }
  console.log(`🏆  Final: ${pick.length}/${N} highlights`);

  return pick.map((h) => ({
    startTime: secToHhmmss(Math.max(0, h.startSeconds - margin)),
    endTime: secToHhmmss(h.endSeconds + margin),
    score: h.score,
  }));
}
