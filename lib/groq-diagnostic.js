import { Groq } from "groq-sdk";
export async function quickScan(subs, apiKey, model = "meta-llama/llama-4-maverick-17b-128e-instruct") {
  const groq = new Groq({ apiKey });
  const text = subs.map((s) => `[${s.startTime}] ${s.text}`).join("\n");
  const resp = await groq.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          `List the first 10 QUESTION lines and the very next ANSWER line from ` +
          `this transcript. Use "[HH:MM:SS] text" per line.`,
      },
      { role: "user", content: text.slice(0, 15_000) }, // first ~12k chars
    ],
  });
  console.log(
    "\n=== DIAGNOSTIC SAMPLE ===\n" +
      (resp.choices[0].message.content || "").trim() +
      "\n=========================\n"
  );
}
