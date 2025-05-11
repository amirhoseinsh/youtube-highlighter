// ./lib/srt-utils.js
import { spawn } from "child_process";
import fs from "fs-extra";
import path from "path";

async function runYtDlp(args) {
  await new Promise((resolve, reject) => {
    const p = spawn("python", args);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) =>
      c ? reject(new Error(err || `yt-dlp exit ${c}`)) : resolve()
    );
    p.on("error", reject);
  });
}

// ───────────────────────────────────────────────────────────
// 1. helper ─ find the next numbered file
// ───────────────────────────────────────────────────────────
async function getNextSubtitleFilename(dir) {
  await fs.ensureDir(dir);
  const files = (await fs.readdir(dir)).filter((f) =>
    /^subtitle_(\d+)\.srt$/.test(f)
  );
  const max = files.reduce(
    (m, f) => Math.max(m, +f.match(/^subtitle_(\d+)\.srt$/)[1]),
    0
  );
  return path.join(dir, `subtitle_${max + 1}.srt`);
}

// ───────────────────────────────────────────────────────────
// 2. tiny utils
// ───────────────────────────────────────────────────────────
const pad2 = (n) => String(n).padStart(2, "0");

function formatTime(milliseconds) {
  if (milliseconds === null || isNaN(milliseconds)) return "00:00:00";
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${padZero(hours)}:${padZero(minutes)}:${padZero(seconds)}`;
}

function padZero(num) {
  return num.toString().padStart(2, "0");
}
// Accept HH:MM:SS,mmm *or* MM:SS,mmm
export function parseTimestamp(ts) {
  const [time, ms] = ts.trim().split(/[.,]/);
  if (!ms) return null;
  let parts = time.split(":").map(Number);
  if (parts.length === 2) parts = [0, ...parts]; // add missing hours
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  const [h, m, s] = parts;
  return ((h * 60 + m) * 60 + s) * 1000 + +ms;
}

// ───────────────────────────────────────────────────────────
// 3. robust VTT ➜ SRT converter
// ───────────────────────────────────────────────────────────
function vttTimeToSrt(t) {
  // t → "MM:SS.mmm" | "HH:MM:SS.mmm"
  let [time, ms] = t.trim().split(".");
  let parts = time.split(":");
  if (parts.length === 2) parts = ["00", ...parts];
  return `${parts.map((p) => p.padStart(2, "0")).join(":")},${ms
    .padEnd(3, "0")
    .slice(0, 3)}`;
}

export async function convertVttToSrt(vtt) {
  if (!vtt || typeof vtt !== "string") throw new Error("Empty VTT");
  const lines = vtt
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter(
      (l) => !l.startsWith("WEBVTT") && !l.startsWith("NOTE") && l.trim() !== ""
    );

  const cues = [];
  let cue = null;

  for (const line of lines) {
    if (line.includes("-->")) {
      const [startRaw, rest] = line.split("-->");
      const [endRaw] = rest.trim().split(/\s+/); // strip cue‑settings
      cue && cues.push(cue);
      cue = {
        start: vttTimeToSrt(startRaw),
        end: vttTimeToSrt(endRaw),
        text: [],
      };
    } else if (cue) {
      cue.text.push(line.trim());
    }
  }
  if (cue) cues.push(cue);

  if (!cues.length) throw new Error("No cues found after VTT → SRT conversion");

  return cues
    .map((c, i) => {
      // join all the little bits…
      let text = c.text.join(" ");

      // then strip out any <HH:MM:SS.mmm> timestamps
      text = text.replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, "");

      // and strip out any <c>…</c> styling classes
      text = text.replace(/<\/?c>/g, "");

      // finally collapse multiple spaces and trim
      text = text.replace(/\s+/g, " ").trim();

      return `${i + 1}\n${c.start} --> ${c.end}\n${text}`;
    })
    .join("\n\n");
}

// ───────────────────────────────────────────────────────────
// 4. plain‑text SRT parser (unchanged behaviour)
// ───────────────────────────────────────────────────────────
export function parseSrt(srt, src = "input") {
  if (!srt || typeof srt !== "string") {
    console.error(`[parseSrt] Received invalid content for ${src}`);
    return [];
  }
  return srt
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .flatMap((block) => {
      const [, time, ...textLines] = block.trim().split("\n");
      if (!time || !textLines.length) return [];
      const [startRaw, endRaw] = time.split(" --> ");
      const start = parseTimestamp(startRaw);
      const end = parseTimestamp(endRaw);
      if (start == null || end == null || start > end) return [];
      return [{ start, end, text: textLines.join(" ").trim() }];
    });
}

// -----------------------------------------------
// 5. downloadSubtitles()
// -----------------------------------------------
export async function downloadSubtitles(url) {
  const tempDir = path.join(process.cwd(), "temp");
  const downloadsDir = path.join(process.cwd(), "downloads");

  await fs.emptyDir(tempDir); // clean slate every run
  await fs.ensureDir(downloadsDir);

  let tempFilePath = null; // will receive the final temp filename
  let finalSrtPath = await getNextSubtitleFilename(downloadsDir);

  /* ---------- 1st try: manual ENGLISH subtitles ---------- */
  let ytArgs = [
    "-m",
    "yt_dlp",
    "--no-check-certificate",
    "--skip-download",
    "--write-sub", // manual captions only
    "--sub-lang",
    "en.*", // any English variant
    "--sub-format",
    "vtt",
    "--output",
    path.join(tempDir, "%(id)s.%(ext)s"),
    url,
  ];
  await runYtDlp(ytArgs);

  /* ---------- collect files ---------- */
  let files = (await fs.readdir(tempDir)).filter((f) =>
    /\.(vtt|srt)$/i.test(f)
  );

  /* ---------- 2nd try: AUTO English if manual failed ---------- */
  if (!files.length) {
    console.warn("⚠ no manual EN captions – trying auto-generated EN …");
    await fs.emptyDir(tempDir);

    ytArgs = [
      "-m",
      "yt_dlp",
      "--no-check-certificate",
      "--skip-download",
      "--write-auto-sub", // auto captions
      "--sub-lang",
      "en.*",
      "--sub-format",
      "vtt",
      "--output",
      path.join(tempDir, "%(id)s.%(ext)s"),
      url,
    ];
    await runYtDlp(ytArgs);
    files = (await fs.readdir(tempDir)).filter((f) => /\.(vtt|srt)$/i.test(f));
  }

  /* ---------- 3rd (optional) try: any language ---------- */
  if (!files.length) {
    console.warn("⚠ no EN captions at all – grabbing any language …");
    await fs.emptyDir(tempDir);

    ytArgs = [
      "-m",
      "yt_dlp",
      "--no-check-certificate",
      "--skip-download",
      "--write-auto-sub",
      "--write-sub",
      "--sub-lang",
      "*", // whatever exists
      "--sub-format",
      "vtt",
      "--output",
      path.join(tempDir, "%(id)s.%(ext)s"),
      url,
    ];
    await runYtDlp(ytArgs);
    files = (await fs.readdir(tempDir)).filter((f) => /\.(vtt|srt)$/i.test(f));
  }

  if (!files.length) throw new Error("This video has no captions at all.");

  /* ---------- pick the best file ---------- */
  const priority = (f) => {
    // manual EN first, then auto EN, then others
    const auto = /\.auto\./i.test(f);
    const en = /\.en[\w-]*\./i.test(f);
    return (auto ? 2 : 0) + (en ? 0 : 1);
  };
  files.sort((a, b) => priority(a) - priority(b));

  const subtitleFile = files[0];
  const isVtt = /\.vtt$/i.test(subtitleFile);
  tempFilePath = path.join(tempDir, subtitleFile);

  /* ---------- read & convert if needed ---------- */
  const tempContent = await fs.readFile(tempFilePath, "utf8");
  const srtContent = isVtt ? await convertVttToSrt(tempContent) : tempContent;

  /* ---------- save final numbered SRT ---------- */
  await fs.writeFile(finalSrtPath, srtContent);
  console.log(`[downloadSubtitles] Saved → ${finalSrtPath}`);

  /* ---------- parse & return ---------- */
  const parsed = parseSrt(srtContent, finalSrtPath);
  console.log(`[downloadSubtitles] Parsed ${parsed.length} cues`);

  await fs.remove(tempFilePath); // tidy up

  return {
    subtitles: parsed.map((x) => ({
      startTime: formatTime(x.start),
      endTime: formatTime(x.end),
      text: x.text,
    })),
    savedSrtPath: finalSrtPath,
  };
}

/**
 * Parse a HH:MM:SS string into milliseconds.
 * @param {string} hms  e.g. "00:03:21"
 * @returns {number|null}
 */
export function parseTimestampHMS(hms) {
  if (!/^\d{2}:\d{2}:\d{2}$/.test(hms)) return null;
  const [h, m, s] = hms.split(":").map(Number);
  return ((h * 60 + m) * 60 + s) * 1000;
}

export function formatSrtTimestamp(ms) {
  const z = (n) => String(n).padStart(2, "0");
  return (
    z(Math.floor(ms / 3600000)) +
    ":" +
    z(Math.floor(ms / 60000) % 60) +
    ":" +
    z(Math.floor(ms / 1000) % 60) +
    "," +
    String(ms % 1000).padStart(3, "0")
  );
}
