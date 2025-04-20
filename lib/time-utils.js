// lib/time-utils.js
/* ----------------------------------------------------------- */
/*  Convert between HH:MM:SS (or HH:MM:SS,mmm) and seconds     */
/* ----------------------------------------------------------- */


export function hhmmssToSec(ts) {
  return ts
    .split(/[:,]/)
    .reduce((t, v, i, a) => t + +v * [3600, 60, 1, 0.001][i + 4 - a.length], 0);
}
export function secToHhmmss(s) {
  return [3600, 60, 1]
    .map((d) => String(Math.floor(s / d) % 60).padStart(2, "0"))
    .join(":");
}
