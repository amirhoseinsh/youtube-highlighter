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

// Helper function to extract YouTube Video ID
function getYoutubeVideoId(url) {
  let videoId = null;
  try {
    const urlObj = new URL(url);
    if (urlObj.hostname === 'youtu.be') {
      videoId = urlObj.pathname.slice(1); // Might include query params if path is like /ID?query
    } else if (urlObj.hostname.includes('youtube.com') && urlObj.pathname === '/watch') {
      videoId = urlObj.searchParams.get('v');
    } else if (urlObj.hostname.includes('youtube.com') && urlObj.pathname.startsWith('/embed/')) {
      videoId = urlObj.pathname.split('/embed/')[1];
    } else if (urlObj.hostname.includes('youtube.com') && urlObj.pathname.startsWith('/shorts/')) {
      videoId = urlObj.pathname.split('/shorts/')[1];
    }

    // Ensure query parameters are stripped from any extracted videoId
    if (videoId && videoId.includes('?')) {
      videoId = videoId.split('?')[0];
    }
  } catch (e) {
    console.error(`[getYoutubeVideoId] Error parsing URL: ${url}`, e);
    // Fallback for non-URL-object parseable strings, or simple IDs
    // This fallback might also benefit from query stripping if it's a full URL somehow
    if (typeof url === 'string' && url.includes('?')) {
        const potentialId = url.split('?')[0].slice(-11); // A guess for IDs in malformed URLs
        if (potentialId.length === 11 && !potentialId.includes('.')) return potentialId;
    } else if (typeof url === 'string' && url.length === 11 && !url.includes('.')) {
        return url; // Basic check for an ID string
    }
    return null;
  }
  return videoId;
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
// Accepts outputBasePath (e.g., downloads/PROJECT_NAME/PROMPT_NAME)
// Creates a video-ID specific subfolder within outputBasePath for all its files.
export async function downloadSubtitles(url, outputBasePath) {
  if (!outputBasePath) {
    throw new Error("[downloadSubtitles] outputBasePath is required.");
  }
  const videoId = getYoutubeVideoId(url);
  if (!videoId) {
    throw new Error(`[downloadSubtitles] Could not extract video ID from URL: ${url}`);
  }

  // Create the video-specific output directory, e.g., downloads/PROJECT_NAME/PROMPT_NAME/VIDEO_ID
  const videoSpecificOutputDir = path.join(outputBasePath, videoId);
  await fs.ensureDir(videoSpecificOutputDir);

  // Use a unique temporary subdirectory for this specific subtitle download operation
  // to prevent conflicts and ensure targeted cleanup.
  const mainTempDir = path.join(process.cwd(), "temp");
  await fs.ensureDir(mainTempDir);
  const tempSubDir = path.join(mainTempDir, `subs_${videoId}_${Date.now()}`);
  await fs.ensureDir(tempSubDir);

  let tempFilePath = null; // will receive the final temp filename from yt-dlp
  // The final SRT will be saved in the videoSpecificOutputDir
  const finalSrtPath = path.join(videoSpecificOutputDir, "subtitle.srt"); 

  /* ---------- 1st try: manual ENGLISH subtitles ---------- */
  let ytArgs = [
    "-m",
    "yt_dlp",
    "--no-check-certificate",
    "--cookies", path.join(process.cwd(), "cookies.txt"),
    "--geo-bypass",
    "--sleep-interval", "5",
    "--skip-download",
    "--write-sub", // manual captions only
    "--sub-lang",
    "en.*", // any English variant
    "--sub-format",
    "vtt",
    "--output",
    path.join(tempSubDir, "%(id)s.%(ext)s"), // Download to unique temp sub dir
    url,
  ];
  try {
    await runYtDlp(ytArgs);
  } catch (e) {
    // Log yt-dlp errors but try to continue if possible, or rethrow if fatal
    console.warn(`[downloadSubtitles] yt-dlp (manual subs) failed: ${e.message}`);
    // Depending on the error, you might decide to rethrow or handle differently
    // For now, we'll let it proceed to try auto-subs if this fails (e.g. no manual subs found)
  }

  /* ---------- collect files ---------- */
  let files = [];
  try {
    files = (await fs.readdir(tempSubDir)).filter((f) =>
      /\.(vtt|srt)$/i.test(f)
    );
  } catch (readError) {
    console.warn(`[downloadSubtitles] Could not read temp subtitle directory ${tempSubDir}: ${readError.message}`);
    // If we can't read the temp dir, likely yt-dlp failed to create any files.
  }

  /* ---------- 2nd try: AUTO English if manual failed ---------- */
  if (!files.length) {
    console.warn("⚠ no manual EN captions – trying auto-generated EN …");
    // No need to emptyDir tempSubDir as it's unique per attempt type or we use a new one
    // For simplicity, we continue using the same tempSubDir for this operation's retries.

    ytArgs = [
      "-m",
      "yt_dlp",
      "--no-check-certificate",
      "--cookies", path.join(process.cwd(), "cookies.txt"),
      "--geo-bypass",
      "--sleep-interval", "5",
      "--skip-download",
      "--write-auto-sub", // auto captions
      "--sub-lang",
      "en.*",
      "--sub-format",
      "vtt",
      "--output",
      path.join(tempSubDir, "%(id)s.%(ext)s"), // Download to unique temp sub dir
      url,
    ];
    try {
      await runYtDlp(ytArgs);
      files = (await fs.readdir(tempSubDir)).filter((f) => /\.(vtt|srt)$/i.test(f));
    } catch (e) {
      console.warn(`[downloadSubtitles] yt-dlp (auto EN subs) failed: ${e.message}`);
    }
  }

  /* ---------- 3rd (optional) try: any language ---------- */
  if (!files.length) {
    console.warn("⚠ no EN captions at all – grabbing any language …");
    ytArgs = [
      "-m",
      "yt_dlp",
      "--no-check-certificate",
      "--cookies", path.join(process.cwd(), "cookies.txt"),
      "--geo-bypass",
      "--sleep-interval", "5",
      "--skip-download",
      "--write-auto-sub",
      "--write-sub",
      "--sub-lang",
      "*", // whatever exists
      "--sub-format",
      "vtt",
      "--output",
      path.join(tempSubDir, "%(id)s.%(ext)s"), // Download to unique temp sub dir
      url,
    ];
    try {
      await runYtDlp(ytArgs);
      files = (await fs.readdir(tempSubDir)).filter((f) => /\.(vtt|srt)$/i.test(f));
    } catch (e) {
      console.warn(`[downloadSubtitles] yt-dlp (any lang subs) failed: ${e.message}`);
    }
  }

  if (!files.length) {
    // Before throwing, attempt to clean up the unique temp subdirectory
    try { await fs.remove(tempSubDir); } catch (cleanupError) { 
      console.warn(`[downloadSubtitles] Warning: Failed to clean up temp directory ${tempSubDir}: ${cleanupError.message}`);
    }
    throw new Error("This video has no captions at all after all attempts.");
  }

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
  tempFilePath = path.join(tempSubDir, subtitleFile);

  /* ---------- read & convert if needed ---------- */
  const tempContent = await fs.readFile(tempFilePath, "utf8");
  const srtContent = isVtt ? await convertVttToSrt(tempContent) : tempContent;

  /* ---------- save final numbered SRT ---------- */
  await fs.writeFile(finalSrtPath, srtContent); // finalSrtPath is now in videoSpecificOutputDir
  console.log(`[downloadSubtitles] Saved → ${finalSrtPath}`);

  /* ---------- parse & return ---------- */
  const parsed = parseSrt(srtContent, finalSrtPath);
  console.log(`[downloadSubtitles] Parsed ${parsed.length} cues`);

  // Clean up the unique temporary subdirectory for this operation
  try {
    await fs.remove(tempSubDir);
  } catch (cleanupError) {
    // Log as a warning, as the main task (getting subs) is done.
    console.warn(`[downloadSubtitles] Warning: Failed to clean up temp directory ${tempSubDir}: ${cleanupError.message}`);
  }

  return {
    subtitles: parsed.map((x) => ({
      startTime: formatTime(x.start),
      endTime: formatTime(x.end),
      text: x.text,
    })),
    savedSrtPath: finalSrtPath, // This is now .../PROMPT_NAME/VIDEO_ID/subtitle.srt
    videoSpecificOutputDir,    // This is .../PROMPT_NAME/VIDEO_ID/
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
