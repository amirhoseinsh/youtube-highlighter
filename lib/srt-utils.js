// ./lib/srt-utils.js
import { spawn } from "child_process";
import fs from "fs-extra";
import path from "path";

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
    .map((c, i) => `${i + 1}\n${c.start} --> ${c.end}\n${c.text.join(" ")}\n`)
    .join("\n");
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

// ───────────────────────────────────────────────────────────
// 5. downloadSubtitles()  ⟵  unchanged *except* it now
//    imports the new helpers above, so just keep your
//    original implementation here.
// ───────────────────────────────────────────────────────────

export async function downloadSubtitles(url) {
  const tempDir = path.join(process.cwd(), "temp");
  const downloadsDir = path.join(process.cwd(), "downloads");
  let tempFilePath = null; // Track the temporary downloaded file
  let finalSrtPath = null; // Track the final numbered SRT path

  try {
    // Ensure directories exist
    await fs.ensureDir(tempDir);
    await fs.ensureDir(downloadsDir);

    // Determine the final numbered filename
    finalSrtPath = await getNextSubtitleFilename(downloadsDir);
    console.log(
      `Determined next subtitle filename: ${path.basename(finalSrtPath)}`
    );

    // --- Download subtitles using yt-dlp ---
    console.log("Attempting to download subtitles using yt-dlp...");
    await new Promise((resolve, reject) => {
      const ytDlpArgs = [
        "-m",
        "yt_dlp",
        "--no-check-certificate",
        "--write-auto-sub", // Attempt to get auto-subs
        "--skip-download", // Don't download video
        "--cookies",
        "youtube_cookies.txt", // Use cookies if available/needed
        "--sub-format",
        "vtt", // Prefer VTT for consistent conversion
        "--sub-lang",
        "en", // Specify English
        // Output to temp directory using video title initially
        "--output",
        path.join(tempDir, "%(title)s.%(ext)s"),
        url,
      ];
      const ytDlp = spawn("python", ytDlpArgs);
      let errorOutput = "";
      let stdOutput = ""; // Capture standard output too if needed for debugging yt-dlp itself
      ytDlp.stdout.on("data", (data) => {
        stdOutput += data.toString();
      });
      ytDlp.stderr.on("data", (data) => {
        errorOutput += data.toString();
      });
      ytDlp.on("close", (code) => {
        if (code !== 0) {
          // Handle common errors specifically for better user feedback
          if (errorOutput.includes("no suitable subtitles found")) {
            reject(
              new Error(
                "No suitable English subtitles found (checked auto-subs)."
              )
            );
          } else if (errorOutput.includes("Sign in to confirm")) {
            reject(
              new Error(
                "YouTube requires authentication (Sign-in). Check cookies.txt."
              )
            );
          } else {
            console.error("yt-dlp stderr:", errorOutput); // Log the full error
            reject(
              new Error(
                `yt-dlp failed (code ${code}). See console for details.`
              )
            );
          }
        } else {
          // Optional: Log success output from yt-dlp if needed
          // console.log("yt-dlp stdout:", stdOutput);
          resolve();
        }
      });
      ytDlp.on("error", (err) => {
        // Handle errors launching the process itself
        reject(new Error(`Failed to start yt-dlp process: ${err.message}`));
      });
    });

    // --- Find the downloaded file in temp directory ---
    const files = await fs.readdir(tempDir);
    // Prioritize VTT (with language code if possible), fallback to SRT
    let subtitleFile =
      files.find((f) => f.endsWith(".en.vtt")) ||
      files.find((f) => f.endsWith(".vtt"));
    let isVtt = true; // Assume VTT unless we find SRT first
    if (!subtitleFile) {
      subtitleFile =
        files.find((f) => f.endsWith(".en.srt")) ||
        files.find((f) => f.endsWith(".srt"));
      isVtt = false; // Found SRT instead
      if (!subtitleFile) {
        // If still not found, throw error
        throw new Error(
          "No subtitle file (.vtt or .srt) found in temp directory after download."
        );
      }
      console.warn(
        `[downloadSubtitles] Downloaded ${path.extname(
          subtitleFile
        )} directly instead of VTT.`
      );
    }
    tempFilePath = path.join(tempDir, subtitleFile); // Full path to the temp file

    // --- Read content, Convert VTT if needed ---
    let srtContent; // Initialize to be assigned below
    const tempContent = await fs.readFile(tempFilePath, "utf-8");

    if (isVtt) {
      console.log(
        `[downloadSubtitles] Converting temporary VTT file to SRT: ${subtitleFile}`
      );
      try {
        // Await the conversion and assign the result
        srtContent = await convertVttToSrt(tempContent);
      } catch (conversionError) {
        console.error(
          `[downloadSubtitles] Error during VTT->SRT conversion step: ${conversionError.message}`
        );
        // Stop execution by re-throwing the error
        throw conversionError;
      }
    } else {
      console.log(
        `[downloadSubtitles] Using directly downloaded SRT: ${subtitleFile}`
      );
      srtContent = tempContent; // Use the content directly
    }

    // --- Sanity check srtContent before writing/parsing ---
    if (typeof srtContent !== "string") {
      // This should ideally not be reached if errors are handled above, but is a safeguard
      throw new Error(
        `[downloadSubtitles] Failed to obtain valid SRT content string for ${tempFilePath}`
      );
    }

    // --- Save the final SRT to the numbered path ---
    console.log(`[downloadSubtitles] Saving final SRT to: ${finalSrtPath}`);
    await fs.writeFile(finalSrtPath, srtContent);

    // --- Parse the final SRT content ---
    console.log(
      `[downloadSubtitles] Parsing final SRT content from ${path.basename(
        finalSrtPath
      )} for analysis...`
    );
    // Pass the string content and the final path for logging context
    const parsedSubtitles = parseSrt(srtContent, finalSrtPath);

    // Log success or failure (failure logged within parseSrt)
    if (parsedSubtitles.length > 0) {
      console.log(
        `[downloadSubtitles] Successfully parsed ${parsedSubtitles.length} subtitle entries.`
      );
    }

    // --- Clean up temporary file ---
    // console.log(`[downloadSubtitles] Cleaning up temporary file: ${tempFilePath}`);
    await fs.remove(tempFilePath);
    tempFilePath = null; // Mark as removed

    // --- Return parsed data and the final numbered save path ---
    return {
      subtitles: parsedSubtitles.map((sub) => ({
        startTime: formatTime(sub.start), // Format to HH:MM:SS for API/downstream use
        endTime: formatTime(sub.end), // Format to HH:MM:SS
        text: sub.text,
      })),
      savedSrtPath: finalSrtPath, // The path like './downloads/subtitle_1.srt'
    };
  } catch (error) {
    // Catch any error from the process (yt-dlp, fs, conversion, parsing)
    console.error(
      `[downloadSubtitles] Error during subtitle download/processing: ${error.message}`
    );
    // Attempt to clean up the temporary file even if an error occurred
    if (tempFilePath && (await fs.pathExists(tempFilePath))) {
      await fs
        .remove(tempFilePath)
        .catch((e) =>
          console.error(
            "[downloadSubtitles] Error cleaning up temp file during error handling:",
            e
          )
        );
    }
    // Rethrow the error so the calling function (processor.js) knows it failed
    throw error;
  }
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
  const z = n => String(n).padStart(2,"0");
  return (
    z(Math.floor(ms/3600000)) + ":" +
    z(Math.floor(ms/60000) % 60) + ":" +
    z(Math.floor(ms/1000)  % 60) + "," +
    String(ms % 1000).padStart(3,"0")
  );
}