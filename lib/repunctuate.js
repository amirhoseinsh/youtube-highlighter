// lib/repunctuate.js
import { spawnSync } from "child_process";

/* ------------------ quick JS fallback ------------------ */
function cheapPunctuate(subs) {
  return subs.map((s) => {
    let t = s.text.trim();
    if (!/[.?!]$/.test(t)) t += ".";
    return { ...s, text: t };
  });
}

/* --------------------- main ----------------------------- */
export function repunctuate(subs) {
  // ----- attempt the Python model -----
  const py = spawnSync("python", ["-c", PUNCT_SNIPPET], {
    encoding: "utf8",
    input: subs.map((s) => s.text).join(" "),
  });

  if (py.status !== 0 || !py.stdout) {
    // python missing or errored
    console.warn("⚠️  Python punctuator failed – using JS fallback.");
    return cheapPunctuate(subs);
  }

  const lines = py.stdout.trim().split(/\n+/).filter(Boolean);
  if (lines.length < 3) {
    // somehow produced nothing useful
    console.warn("⚠️  Punctuator empty – using JS fallback.");
    return cheapPunctuate(subs);
  }

  /* map naive timeline (keeps things simple and safe) */
  const total = subs.at(-1).end - subs[0].start;
  const chars = subs.map((s) => s.text.length).reduce((a, b) => a + b, 0);
  const msPer = total / chars;

  let cursor = subs[0].start;
  return lines.map((txt) => {
    const lenMs = txt.length * msPer;
    const obj = { start: cursor, end: cursor + lenMs, text: txt };
    cursor += lenMs;
    return obj;
  });
}

/* -------- minimal Python snippet (30 KB model) ---------- */
const PUNCT_SNIPPET = `
import sys, torch, warnings, transformers as tr
warnings.filterwarnings("ignore")
tok  = tr.AutoTokenizer.from_pretrained("kredor/punctuate-all")
mdl  = tr.AutoModelForSeq2SeqLM.from_pretrained("kredor/punctuate-all")
txt  = sys.stdin.read().strip()
out  = mdl.generate(**tok(txt,return_tensors="pt"),max_new_tokens=256)
print(tok.decode(out[0], skip_special_tokens=True))
`;
