// lib/question-classifier.js  – improved Q/A/O labeller
// ------------------------------------------------------------------
//  * Labels a single **Q** line, then the **first** clear reply as **A**.
//  * Further lines revert to **O** unless they themselves look like Q.
//  * Greatly reduces false‑positive Q’s and never produces an all‑A stream.
//  Public API unchanged.

import { Groq } from "groq-sdk";

/* ────────── throttle (free‑tier) ────────── */
const TPM = 15_000,
  RPM = 30;
let tokAvail = TPM,
  rpmAvail = RPM,
  last = Date.now();
async function throttle(tok) {
  const now = Date.now(),
    dt = now - last;
  tokAvail = Math.min(TPM, tokAvail + (TPM * dt) / 60_000);
  rpmAvail = Math.min(RPM, rpmAvail + (RPM * dt) / 60_000);
  last = now;
  const wait = Math.max(
    tok > tokAvail ? ((tok - tokAvail) * 60_000) / TPM : 0,
    rpmAvail < 1 ? ((1 - rpmAvail) * 60_000) / RPM : 0
  );
  if (wait) {
    await new Promise((r) => setTimeout(r, wait));
    return throttle(tok);
  }
  tokAvail -= tok;
  rpmAvail -= 1;
}

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

/* ────────── main ────────── */
export async function classifySentences(
  sentences,
  apiKey,
  model = "meta-llama/llama-4-maverick-17b-128e-instruct"
) {
  const labels = new Array(sentences.length).fill("O");

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

  /* undecided = still O and not immediately after Q */
  const undecidedIdx = labels
    .map((lab, idx) => (lab === "O" ? idx : null))
    .filter((idx) => idx !== null);

  if (!undecidedIdx.length) {
    console.log("ℹ️  classify: heuristic pass covered all lines");
    return sentences.map((s, i) => ({ ...s, label: labels[i] }));
  }

  /* Groq only for the remaining O lines ----------------------- */
  const groq = new Groq({ apiKey });
  const BATCH = 1_800;
  let totalBatch = 0,
    ptr = 0;
  while (ptr < undecidedIdx.length) {
    let est = FEW.length / 4;
    while (ptr < undecidedIdx.length && est < BATCH) {
      est += sentences[undecidedIdx[ptr]].text.length / 4;
      ptr++;
    }
    totalBatch++;
  }

  let batchNo = 0;
  for (let p = 0; p < undecidedIdx.length; ) {
    const start = p;
    let estTok = FEW.length / 4;
    while (p < undecidedIdx.length && estTok < BATCH) {
      estTok += sentences[undecidedIdx[p]].text.length / 4;
      p++;
    }
    const idxSlice = undecidedIdx.slice(start, p);
    const batch = idxSlice.map((i) => sentences[i]);

    const prompt =
      FEW +
      "\n" +
      batch.map((s) => `Sentence: \"${s.text}\"\nLabel:`).join("\n");

    await throttle(Math.ceil(estTok));
    batchNo++;
    console.log(
      `🟦 classify batch ${batchNo}/${totalBatch} (${batch.length} sent)`
    );

    const {
      choices: [
        {
          message: { content = "" },
        },
      ],
    } = await groq.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: batch.length * 2,
      messages: [{ role: "user", content: prompt }],
    });

    const outs = content
      .trim()
      .split(/\s+/)
      .filter((x) => /^[QAO]$/i.test(x));
    idxSlice.forEach((idx, k) => {
      labels[idx] = outs[k] || "O";
    });
  }

  /* ensure any orphan Q has at least one A --------------------- */
  for (let i = 0; i < labels.length - 1; i++) {
    if (labels[i] === "Q" && labels[i + 1] === "O") labels[i + 1] = "A";
  }

  return sentences.map((s, i) => ({ ...s, label: labels[i] }));
}
