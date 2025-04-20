import { msToHms } from "./time.js";

export function pickTop(scored, N, minMs, marginMs = 2000) {
  const out = [],
    clash = (a, b) =>
      !(
        a.end + marginMs < b.start - marginMs ||
        b.end + marginMs < a.start - marginMs
      );
  for (const w of scored) {
    if (out.length === N) break;
    if (w.end - w.start >= minMs && out.every((o) => !clash(o, w))) out.push(w);
  }
  // still short ➜ allow shorter windows
  for (const w of scored) {
    if (out.length === N) break;
    if (out.every((o) => !clash(o, w))) out.push(w);
  }
  return out.slice(0, N).map(({ start, end, score }) => ({
    startTime: msToHms(Math.max(0, start - marginMs)),
    endTime: msToHms(end + marginMs),
    score,
  }));
}
