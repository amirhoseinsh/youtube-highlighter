// lib/question‑segments.js
export function extractCandidateSegments(subs, minSeconds) {
  const segs = [];
  for (let i = 0; i < subs.length; i++) {
    if (!subs[i].text.trim().endsWith("?")) continue; // a question line
    const start = subs[i].start; // ms
    // walk until next question or 3 min cap
    let j = i + 1;
    while (
      j < subs.length &&
      !subs[j].text.trim().endsWith("?") &&
      subs[j].end - start < 180_000
    )
      j++;
    const end = subs[j - 1].end;
    if ((end - start) / 1000 >= minSeconds) {
      segs.push({
        startMs: start,
        endMs: end,
        startTime: subs[i].startTime,
        endTime: subs[j - 1].endTime,
        block: subs
          .slice(i, j)
          .map((s) => s.text)
          .join(" "),
      });
    }
  }
  return segs; // usually 20‑80 segments even for long talks
}
