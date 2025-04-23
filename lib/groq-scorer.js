// lib/groq-scorer.js            (overwrite the whole file)
import { Groq } from "groq-sdk";

/* tunables ------------------------------------------------- */
const MODEL = "meta-llama/llama-4-maverick-17b-128e-instruct";
const TOK_PER_CHAR = 0.25; // ≈4 chars / tok
const MAX_CTX_TOK = 8_000; // stay well < 16 k
let MAX_SEG_PER_BATCH = 40; // dynamic if we hit ctx overflow
const TPM = 15_000,
  RPM = 30; // gemma / llama free tier

/* simple token/RPM bucket --------------------------------- */
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

/* build a single prompt for N segments -------------------- */
function batchPrompt(segments) {
  const list = segments
    .map((s, i) => `#${i + 1}  ${s.text.trim().replace(/\s+/g, " ")}`)
    .join("\n\n");

  return `
You are a strict viral‑video editor.

For each numbered segment below, output **one integer 1‑5** on the same
line order, comma‑separated.  5 = extremely share‑worthy, 1 = poor.

Segments:
${list}

Reply with comma‑separated integers only. Example: 5,4,3
`.trim();
}

/* --------------------------------------------------------- */
export async function scoreSegments(blocks, apiKey) {
  if (!blocks.length) return [];
  const groq = new Groq({ apiKey });
  const scored = [];

  let idx = 0,
    batchNo = 0;
  while (idx < blocks.length) {
    /* ── build a batch that fits the context window ── */
    let start = idx,
      tok = 0;
    while (idx < blocks.length) {
      const add = batchPrompt([blocks[idx]]).length * TOK_PER_CHAR;
      if (tok + add > MAX_CTX_TOK || idx - start >= MAX_SEG_PER_BATCH) break;
      tok += add;
      idx++;
    }
    const slice = blocks.slice(start, idx);
    batchNo++;
    console.log(
      `🔸  score batch ${batchNo} (${slice.length} seg, ${Math.ceil(tok)} tok)`
    );

    await throttle(Math.ceil(tok));

    /* ── single‑message prompt ── */
    const prompt = batchPrompt(slice);

    try {
      const {
        choices: [
          {
            message: { content },
          },
        ],
      } = await groq.chat.completions.create({
        model: MODEL,
        temperature: 0,
        max_tokens: slice.length * 2, // plenty
        messages: [{ role: "user", content: prompt }],
      });

      const nums = (content || "").match(/\d+/g) || [];
      slice.forEach((seg, i) => {
        const n = Number(nums[i] || 1);
        scored.push({ ...seg, score: Math.max(1, Math.min(n, 5)) });
      });
    } catch (e) {
      /* split the batch once if we overflow */
      if (
        e?.response?.data?.error?.code === "context_length_exceeded" &&
        slice.length > 1
      ) {
        console.warn("⚠️  ctx overflow – halving batch size");
        MAX_SEG_PER_BATCH = Math.max(10, Math.floor(MAX_SEG_PER_BATCH / 2));
        idx = start; // rewind
        continue; // retry with smaller batch
      }
      throw e; // propagate other errors
    }
  }

  scored.sort((a, b) => b.score - a.score || a.startMs - b.startMs);
  console.log(
    `🏁  scoring done – ${scored.length}/${blocks.length} segments scored`
  );
  return scored;
}
