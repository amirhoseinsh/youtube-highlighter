import { Groq } from "groq-sdk";

/* ---------- token bucket (gemma2 free tier) --------------- */
const TPM = 15_000,
  RPM = 30;
let tokAvail = TPM,
  rpmAvail = RPM,
  last = Date.now();
async function throttle(tok) {
  const now = Date.now(),
    ms = now - last;
  tokAvail = Math.min(TPM, tokAvail + (TPM * ms) / 60_000);
  rpmAvail = Math.min(RPM, rpmAvail + (RPM * ms) / 60_000);
  last = now;
  const wait = Math.max(
    tok > tokAvail ? ((tok - tokAvail) * 60_000) / TPM : 0,
    rpmAvail < 1 ? ((1 - rpmAvail) * 60_000) / RPM : 0
  );
  if (wait) {
    console.log(`⏳  classify throttle ${Math.ceil(wait / 1000)} s`);
    await new Promise((r) => setTimeout(r, wait));
    return throttle(tok);
  }
  tokAvail -= tok;
  rpmAvail -= 1;
}

/* ---------- richer few‑shot ------------------------------- */
const FEW = `
Sentence: "Where did you grow up?"
Label: Q
Sentence: "I grew up in Chicago."
Label: A
Sentence: "That's interesting."
Label: O
Sentence: "Yeah, absolutely."
Label: A
Sentence: "Why do you think that happened"
Label: Q
Sentence: "Because demand was higher than we expected."
Label: A
`.trim();

const BATCH_TOK = 1_800; // keep well under 8 k ctx

export async function classifySentences(
  sentences,
  apiKey,
  model = "meta-llama/llama-4-maverick-17b-128e-instruct"
) {
  /* --- slice into batches -------------------------------- */
  const batches = [];
  for (let i = 0; i < sentences.length; ) {
    let j = i,
      tok = FEW.length / 4;
    while (j < sentences.length && tok < BATCH_TOK) {
      tok += sentences[j].text.length / 4;
      j++;
    }
    batches.push({ start: i, end: j });
    i = j;
  }
  console.log(`🔍  classify: ${batches.length} batch(es) total`);

  const groq = new Groq({ apiKey });
  const labels = [];

  /* --- run Groq batch‑by‑batch --------------------------- */
  for (let b = 0; b < batches.length; b++) {
    const { start, end } = batches[b];
    const batch = sentences.slice(start, end);

    const prompt =
      FEW + "\n" + batch.map((s) => `Sentence: "${s.text}"\nLabel:`).join("\n");

    const estTok = Math.ceil(prompt.length / 4);
    await throttle(estTok);
    console.log(
      `🔸  classify batch ${b + 1}/${batches.length} ` +
        `(${batch.length} sent, ${estTok} tok)`
    );

    const res = await groq.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: batch.length * 2,
      messages: [{ role: "user", content: prompt }],
    });

    const outs = (res.choices[0].message.content || "").trim().split(/\s+/);
    labels.push(...outs.slice(0, batch.length));
  }

  /* --- naive post‑fix: ensure every Q has at least one A -- */
  for (let i = 0; i < labels.length - 1; i++) {
    if (labels[i] === "Q" && labels[i + 1] === "O") labels[i + 1] = "A";
  }

  while (labels.length < sentences.length) labels.push("O");
  return sentences.map((s, i) => ({ ...s, label: labels[i] || "O" }));
}
