import { Groq } from "groq-sdk";
import { encoding_for_model } from "@dqbd/tiktoken"; // cheap length calc

const enc = encoding_for_model("gpt-3.5-turbo"); // close enough

export async function scoreWindows(wins, apiKey) {
  const groq = new Groq({ apiKey });
  const system =
    "Score from 1‑10 how compelling, insightful, and share‑worthy.";
  const batchSz = 40;
  const scored = [];
  for (let i = 0; i < wins.length; i += batchSz) {
    const slice = wins.slice(i, i + batchSz);
    const promptTok = slice.reduce((n, w) => n + enc.encode(w.text).length, 0);
    console.log(
      `   ▸ scoring batch ${i / batchSz + 1} (${
        slice.length
      } seg, ~${promptTok} tok)`
    );

    const {
      choices: [
        {
          message: { content },
        },
      ],
    } = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      temperature: 0.1,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: slice.map((w, k) => `[${k}] ${w.text}`).join("\n\n"),
        },
      ],
      max_tokens: slice.length * 3,
    });

    // expect lines like “0:8 1:5 …”
    content.split(/\s+/).forEach((pair) => {
      const [idx, score] = pair.split(/[:=]/);
      const w = slice[Number(idx)];
      if (w) scored.push({ ...w, score: Number(score) || 1 });
    });
  }
  return scored.sort((a, b) => b.score - a.score);
}
