import { spawn } from "child_process";
import path from "path";
import fs from "fs-extra";

// --- Import SRT utilities from subtitle-utils.js ---
import {
  parseSrt,
  formatSrtTimestamp, // Use the new HMS parser
  parseTimestampHMS, // Use the new SRT timestamp formatter
} from "./srt-utils.js"; // Adjust path if necessary
// ---

// --- formatTimestamp function specific to this file (HH:MM:SS output) ---
function formatTimestamp(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60); // Use floor for video segments
  // Use padZero if available (import or define it)
  const padZero = (num) => num.toString().padStart(2, "0");
  return `${padZero(hours)}:${padZero(minutes)}:${padZero(seconds)}`;
}
// ---

export async function downloadHighlights(
  url,
  highlights,
  fullSrtPath,
  minSeconds
) {
  // Added fullSrtPath parameter
  const downloadDir = path.join(process.cwd(), "downloads");
  await fs.ensureDir(downloadDir); // Ensure download dir exists (don't empty it here if SRT is inside)

  // --- Load and parse the full SRT file ONCE ---
  let fullSubtitles = [];
  try {
    if (!(await fs.pathExists(fullSrtPath))) {
      throw new Error(`Full SRT file not found at: ${fullSrtPath}`);
    }
    const fullSrtContent = await fs.readFile(fullSrtPath, "utf-8");
    fullSubtitles = parseSrt(fullSrtContent); // Assuming parseSrt returns array of {start, end, text} in ms
    console.log(
      `Successfully parsed ${fullSubtitles.length} entries from full SRT: ${fullSrtPath}`
    );
  } catch (error) {
    console.error(
      `Failed to load or parse the main SRT file: ${error.message}`
    );
    // Decide if you want to continue without SRT generation or stop
    // For now, we'll log the error and continue with video download only
    // throw error; // Uncomment to stop execution if full SRT is essential
    fullSubtitles = null; // Indicate that SRT processing is not possible
  }
  // ---

  // Download each highlight segment and generate its SRT
  for (let i = 0; i < highlights.length; i++) {
    const highlight = highlights[i];
    const highlightIndex = i + 1;
    const videoOutputPath = path.join(
      downloadDir,
      `highlight_${highlightIndex}.mp4`
    );
    const srtOutputPath = path.join(
      downloadDir,
      `highlight_${highlightIndex}.srt`
    ); // Path for the highlight's SRT
    const descPath = path.join(
      downloadDir,
      `highlight_${highlightIndex}_description.txt`
    );

    try {
      // Calculate time window (as before)
      const startParts = highlight.startTime.split(":").map(Number);
      const endParts = highlight.endTime.split(":").map(Number);
      const startSeconds =
        startParts[0] * 3600 + startParts[1] * 60 + startParts[2];
      const endSeconds = endParts[0] * 3600 + endParts[1] * 60 + endParts[2];
      const clipDuration = endSeconds - startSeconds;

      let adjustedStartTime = highlight.startTime; // HH:MM:SS format
      let adjustedEndTime = highlight.endTime; // HH:MM:SS format
      let adjustedStartSeconds = startSeconds;

      // --- Time Adjustment Logic (same as before) ---
      const minDuration = minSeconds;
      const maxDuration = minSeconds * 3;
      if (clipDuration < minDuration) {
        const extendSeconds = Math.ceil((minDuration - clipDuration) / 2);
        adjustedStartSeconds = Math.max(0, startSeconds - extendSeconds);
        const newEndSeconds = adjustedStartSeconds + minDuration; // Ensure final duration is minDuration

        adjustedStartTime = formatTimestamp(adjustedStartSeconds);
        adjustedEndTime = formatTimestamp(newEndSeconds);
      } else if (clipDuration > maxDuration) {
        // If duration is more than maxDuration, trim it from the end
        const newEndSeconds = startSeconds + maxDuration;
        adjustedEndTime = formatTimestamp(newEndSeconds);
        adjustedStartSeconds = startSeconds; // Start time doesn't change in this case
        adjustedStartTime = formatTimestamp(adjustedStartSeconds);
      } else {
        // Clip duration is within bounds, use original adjusted times
        adjustedStartSeconds = startSeconds;
        adjustedStartTime = formatTimestamp(adjustedStartSeconds);
        adjustedEndTime = formatTimestamp(endSeconds);
      }
      // --- End Time Adjustment Logic ---

      // --- Download Video Segment ---
      console.log(
        `Downloading video segment ${highlightIndex}: ${adjustedStartTime} -> ${adjustedEndTime}`
      );
      await downloadSegment(
        url,
        adjustedStartTime,
        adjustedEndTime,
        videoOutputPath
      );
      // ---

      // --- Generate Highlight SRT ---
      if (fullSubtitles) {
        // Only proceed if the full SRT was parsed successfully
        console.log(`Generating SRT for highlight ${highlightIndex}...`);
        try {
          // Get start/end times of the *video segment* in milliseconds
          const segmentStartMs = parseTimestampHMS(adjustedStartTime);
          const segmentEndMs = parseTimestampHMS(adjustedEndTime);

          if (segmentStartMs !== null && segmentEndMs !== null) {
            // Filter subtitles that overlap with the segment's time range
            const highlightSubs = fullSubtitles.filter(
              (sub) => sub.start < segmentEndMs && sub.end > segmentStartMs
            );

            if (highlightSubs.length > 0) {
              // Adjust timestamps and format as SRT blocks
              const highlightSrtContent =
                highlightSubs
                  .map((sub, index) => {
                    // Calculate new times relative to the segment start
                    const newStartMs = Math.max(0, sub.start - segmentStartMs);
                    const newEndMs = Math.max(0, sub.end - segmentStartMs);

                    // Format back to SRT timestamp string
                    const newStartTimeStr = formatSrtTimestamp(newStartMs);
                    const newEndTimeStr = formatSrtTimestamp(newEndMs);

                    // Format the SRT block
                    return `${
                      index + 1
                    }\n${newStartTimeStr} --> ${newEndTimeStr}\n${sub.text}`;
                  })
                  .join("\n\n") + "\n\n"; // Ensure double newline at the end

              // Save the highlight SRT file
              await fs.writeFile(srtOutputPath, highlightSrtContent);
              console.log(
                `Saved SRT for highlight ${highlightIndex} to ${srtOutputPath}`
              );
            } else {
              console.log(
                `No subtitles found within the time range for highlight ${highlightIndex}.`
              );
            }
          } else {
            console.warn(
              `Could not parse adjusted timestamps for highlight ${highlightIndex}, skipping SRT generation.`
            );
          }
        } catch (srtError) {
          console.error(
            `Failed to generate SRT for highlight ${highlightIndex}:`,
            srtError.message
          );
          // Continue with the next highlight even if SRT generation fails
        }
      } else {
        console.warn(
          `Skipping SRT generation for highlight ${highlightIndex} because full SRT could not be processed.`
        );
      }
      // --- End Generate Highlight SRT ---

      // --- Create description file (same as before) ---
      await fs.writeFile(
        descPath,
        `Original Timestamp: ${highlight.startTime} - ${highlight.endTime}\n` +
          `Adjusted Timestamp: ${adjustedStartTime} - ${adjustedEndTime}\n` +
          `Description: ${highlight.description}`
      );
      // ---

      console.log(
        `Processed highlight ${highlightIndex} of ${highlights.length}`
      );
    } catch (error) {
      console.error(
        `Failed to process highlight ${highlightIndex}:`,
        error.message
      );
      // Decide if one failure should stop everything
      // throw error; // Uncomment to stop on first failure
    }
  }
  console.log("Finished processing all highlights.");
}

// downloadSegment function remains the same as in your original code
async function downloadSegment(url, startTime, endTime, outputPath) {
  return new Promise((resolve, reject) => {
    const ytDlpArgs = [
      "-m",
      "yt_dlp",
      "--no-check-certificate", // Added for potential network issues
      "--cookies",
      "youtube_cookies.txt", // Ensure cookies are used if needed for video dl
      "--download-sections",
      `*${startTime}-${endTime}`,
      "--force-keyframes-at-cuts", // Can improve seeking accuracy
      // Try specific MP4 format first, fallback to best video+audio that's mp4 or webm
      "--format",
      "bv*[ext=mp4][height<=720]+ba[ext=m4a]/b[ext=mp4][height<=720]/bv*[ext=webm][height<=720]+ba[ext=webm]/b[ext=webm][height<=720]/best[height<=720]",
      "--output",
      outputPath,
      "--quiet", // Reduce console noise, rely on '.'
      "--progress-template",
      "%(progress._percent_str)s", // Alternative progress
      url,
    ];
    // console.log('yt-dlp download args:', ytDlpArgs.join(' ')); // Debugging
    const ytDlp = spawn("python", ytDlpArgs);

    let errorOutput = "";
    let lastProgress = "";

    ytDlp.stderr.on("data", (data) => {
      errorOutput += data.toString();
      // console.error("yt-dlp stderr:", data.toString()); // Debugging
    });

    ytDlp.stdout.on("data", (data) => {
      const output = data.toString().trim();
      // Attempt to capture progress if using --progress-template
      if (output.endsWith("%")) {
        if (output !== lastProgress) {
          process.stdout.write(`\rDownloading segment: ${output}   `);
          lastProgress = output;
        }
      } else if (output.includes("[download]") && output.includes("%")) {
        // Fallback for default progress format if --quiet is removed
        process.stdout.write(".");
      }
      // console.log("yt-dlp stdout:", output); // Debugging
    });

    ytDlp.on("close", (code) => {
      process.stdout.write("\r" + " ".repeat(lastProgress.length + 25) + "\r"); // Clear progress line
      if (code !== 0) {
        console.error(
          `\nError downloading segment (${startTime}-${endTime}). Exit code: ${code}`
        );
        console.error("yt-dlp stderr:", errorOutput);
        // Try to remove potentially incomplete file
        fs.remove(outputPath).catch(() => {});
        reject(
          new Error(
            `yt-dlp failed (code ${code}) for segment ${startTime}-${endTime}. Check stderr log.`
          )
        );
      } else {
        console.log(
          `Segment ${startTime}-${endTime} downloaded successfully to ${outputPath}`
        );
        resolve();
      }
    });

    ytDlp.on("error", (err) => {
      // Handle spawn errors
      reject(
        new Error(`Failed to start yt-dlp for segment download: ${err.message}`)
      );
    });
  });
}
