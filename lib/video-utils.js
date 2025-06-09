import { spawn } from "child_process";
import path from "path";
import fs from "fs-extra";
import { promisify } from "util";
import { exec } from "child_process";
import logger from "./logger.js";

const execPromise = promisify(exec);

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
    logger.error(`[getYoutubeVideoId] Error parsing URL: ${url}`, e);
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

// Add video metadata cache
const VIDEO_METADATA_CACHE_FILE = path.join(process.cwd(), ".video-metadata-cache.json");
let videoMetadataCache = {};

// Load video metadata cache if it exists
try {
  if (fs.existsSync(VIDEO_METADATA_CACHE_FILE)) {
    videoMetadataCache = fs.readJsonSync(VIDEO_METADATA_CACHE_FILE);
    logger.info(`Loaded video metadata cache with ${Object.keys(videoMetadataCache).length} entries`);
  }
} catch (error) {
  logger.warn(`Failed to load video metadata cache`, error);
  videoMetadataCache = {};
}

// Function to save the video metadata cache
async function saveVideoMetadataCache() {
  try {
    await fs.writeJson(VIDEO_METADATA_CACHE_FILE, videoMetadataCache, { spaces: 0 });
    logger.debug(`Saved video metadata cache with ${Object.keys(videoMetadataCache).length} entries`);
    return true;
  } catch (err) {
    logger.warn(`Failed to save video metadata cache`, err);
    return false;
  }
}

// --- Import SRT utilities from srt-utils.js (corrected filename if it was a typo) ---
import {
  parseSrt,
  formatSrtTimestamp,
  parseTimestampHMS,
} from "./srt-utils.js"; // Adjust path if necessary
// ---

// --- formatTimestamp function specific to this file (HH:MM:SS output) ---
function formatTimestamp(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const padZero = (num) => num.toString().padStart(2, "0");
  return `${padZero(hours)}:${padZero(minutes)}:${padZero(seconds)}`;
}
// ---

// Add a new function to generate thumbnails for videos
export async function generateThumbnail(videoPath, outputDir, quality = 'medium') {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found at: ${videoPath}`);
  }

  // Extract the base name from the video path
  const baseName = path.basename(videoPath, path.extname(videoPath));
  const thumbnailPath = path.join(outputDir, `${baseName}_thumbnail.jpg`);
  
  // Set thumbnail quality size based on option
  const qualitySettings = {
    low: '320x180',     // Low quality (SD)
    medium: '640x360',  // Medium quality (HD)
    high: '1280x720'    // High quality (Full HD)
  };
  
  const thumbnailSize = qualitySettings[quality] || qualitySettings.medium;
  
  logger.debug(`Generating thumbnail for ${videoPath} at quality ${quality} (${thumbnailSize})`);
  
  // Use ffmpeg to extract a thumbnail from the middle of the video
  const ffmpegArgs = [
    '-i', videoPath,
    '-ss', '00:00:01.500', // Take frame at 1.5 seconds in (adjustable position)
    '-vframes', '1',       // Extract just one frame
    '-s', thumbnailSize,   // Set the size based on quality
    '-f', 'image2',        // Image format
    '-q:v', '2',           // High quality (1-31, lower is better)
    thumbnailPath
  ];
  
  return new Promise((resolve, reject) => {
    const process = spawn('ffmpeg', ffmpegArgs);
    
    let errorOutput = '';
    process.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    process.on('close', async (code) => {
      if (code === 0) {
        if (await fs.pathExists(thumbnailPath)) {
          const stats = await fs.stat(thumbnailPath);
          if (stats.size > 100) {
            logger.info(`Thumbnail generated successfully at ${thumbnailPath}`, {
              size: stats.size,
              quality: quality
            });
            resolve(thumbnailPath);
          } else {
            await fs.remove(thumbnailPath);
            reject(new Error(`Failed to generate thumbnail: Output file too small (${stats.size} bytes)`));
          }
        } else {
          reject(new Error(`Failed to generate thumbnail: Output file not found`));
        }
      } else {
        logger.error(`ffmpeg process exited with code ${code}`, {
          errorOutput: errorOutput.substring(0, 500)
        });
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
}

// Update downloadHighlights to support progress reporting callback
export async function downloadHighlights(
  url,
  highlights,
  fullSrtPath,
  minSeconds,
  outputDir, // This is the videoSpecificOutputDir, e.g., .../PROMPT_NAME/VIDEO_ID/
  progressCallback = null,
  options = {
    quality: 'high',
    format: 'mp4',
    smartTrimming: true
  }
) {
  if (!outputDir) {
    throw new Error("[downloadHighlights] outputDir parameter is required.");
  }
  // Ensure the provided outputDir exists (though it should have been created by caller)
  await fs.ensureDir(outputDir);

  let fullSubtitles = [];
  try {
    if (!(await fs.pathExists(fullSrtPath))) {
      throw new Error(`Full SRT file not found at: ${fullSrtPath}`);
    }
    const fullSrtContent = await fs.readFile(fullSrtPath, "utf-8");
    fullSubtitles = parseSrt(fullSrtContent, `full SRT: ${fullSrtPath}`); // Pass identifier to parseSrt
    logger.info(`Parsed subtitles file`, {
      count: fullSubtitles.length,
      file: fullSrtPath
    });
  } catch (error) {
    logger.error(`Failed to load or parse subtitles file`, error);
    fullSubtitles = null;
  }

  const downloadedFiles = [];
  
  for (let i = 0; i < highlights.length; i++) {
    const highlight = highlights[i];
    const highlightIndex = i + 1;
    const videoOutputPath = path.join(
      outputDir, // Use outputDir here
      `highlight_${highlightIndex}.${options.format || 'mp4'}`
    );
    const srtOutputPath = path.join(
      outputDir, // Use outputDir here
      `highlight_${highlightIndex}.srt`
    );
    const descPath = path.join(
      outputDir, // Use outputDir here
      `highlight_${highlightIndex}_description.txt`
    );

    try {
      const startParts = highlight.startTime.split(":").map(Number);
      const endParts = highlight.endTime.split(":").map(Number);
      const startSeconds =
        startParts[0] * 3600 + startParts[1] * 60 + startParts[2];
      const endSeconds = endParts[0] * 3600 + endParts[1] * 60 + endParts[2];
      const clipDuration = endSeconds - startSeconds;

      let adjustedStartTime, adjustedEndTime;
      let adjustedStartSeconds = startSeconds;
      let adjustedEndSeconds = endSeconds;

      const minDuration = minSeconds;
      const maxDuration = minSeconds * 3;

      // Smart trimming: adjust start/end to avoid cutting in the middle of sentences
      if (options.smartTrimming && fullSubtitles && fullSubtitles.length > 0) {
        // Convert seconds to milliseconds for comparison with subtitle timestamps
        const startMs = startSeconds * 1000;
        const endMs = endSeconds * 1000;
        
        // Find better sentence boundaries near the start point
        const startSubs = fullSubtitles.filter(sub => 
          sub.start <= startMs + 3000 && sub.end >= startMs - 3000);
        
        if (startSubs.length > 0) {
          // Find the closest subtitle start that is before our start point
          const betterStart = startSubs
            .filter(sub => sub.start <= startMs)
            .sort((a, b) => b.start - a.start)[0];
            
          if (betterStart) {
            adjustedStartSeconds = Math.floor(betterStart.start / 1000);
            logger.debug(`Smart trim: Adjusted start time to match subtitle boundary`, {
              original: startSeconds,
              adjusted: adjustedStartSeconds
            });
          }
        }
        
        // Find better sentence boundaries near the end point
        const endSubs = fullSubtitles.filter(sub => 
          sub.start <= endMs + 3000 && sub.end >= endMs - 3000);
          
        if (endSubs.length > 0) {
          // Find the closest subtitle end that is after our end point
          const betterEnd = endSubs
            .filter(sub => sub.end >= endMs)
            .sort((a, b) => a.end - b.end)[0];
            
          if (betterEnd) {
            adjustedEndSeconds = Math.ceil(betterEnd.end / 1000);
            logger.debug(`Smart trim: Adjusted end time to match subtitle boundary`, {
              original: endSeconds,
              adjusted: adjustedEndSeconds
            });
          }
        }
      }

      // Apply duration constraints after smart trimming
      const newDuration = adjustedEndSeconds - adjustedStartSeconds;
      
      if (newDuration < minDuration) {
        const extendSeconds = Math.ceil((minDuration - newDuration) / 2);
        adjustedStartSeconds = Math.max(0, adjustedStartSeconds - extendSeconds);
        adjustedEndSeconds = adjustedStartSeconds + minDuration;
      } else if (newDuration > maxDuration) {
        adjustedEndSeconds = adjustedStartSeconds + maxDuration;
      }
      
      adjustedStartTime = formatTimestamp(adjustedStartSeconds);
      adjustedEndTime = formatTimestamp(adjustedEndSeconds);
      
      logger.info(`Preparing to download highlight ${highlightIndex}`, {
        start: adjustedStartTime,
        end: adjustedEndTime,
        duration: Math.round(parseTimestampHMS(adjustedEndTime) - parseTimestampHMS(adjustedStartTime))/1000,
        smartTrimming: options.smartTrimming
      });
      
      const downloadedFile = await downloadSegment(
        url,
        adjustedStartTime,
        adjustedEndTime,
        videoOutputPath,
        highlightIndex,
        {
          quality: options.quality,
          format: options.format
        }
      );
      
      if (downloadedFile) {
        downloadedFiles.push(downloadedFile);
      }

      if (fullSubtitles) {
        logger.debug(`Generating SRT for highlight ${highlightIndex}`);
        try {
          const segmentStartMs = parseTimestampHMS(adjustedStartTime);
          const segmentEndMs = parseTimestampHMS(adjustedEndTime);

          if (segmentStartMs !== null && segmentEndMs !== null) {
            const highlightSubs = fullSubtitles.filter(
              (sub) => sub.start < segmentEndMs && sub.end > segmentStartMs
            );
            logger.debug(
              `Found ${highlightSubs.length} subtitle lines for highlight ${highlightIndex}`
            );

            if (highlightSubs.length > 0) {
              const highlightSrtContent =
                highlightSubs
                  .map((sub, index) => {
                    const newStartMs = Math.max(0, sub.start - segmentStartMs);
                    const newEndMs = Math.max(0, sub.end - segmentStartMs);
                    const newStartTimeStr = formatSrtTimestamp(newStartMs);
                    const newEndTimeStr = formatSrtTimestamp(newEndMs);
                    return `${index + 1}\n${newStartTimeStr} --> ${newEndTimeStr}\n${sub.text}`;
                  })
                  .join("\n\n") + "\n\n";

              await fs.writeFile(srtOutputPath, highlightSrtContent);
              logger.debug(`SRT saved to ${srtOutputPath}`);
              if (highlightSrtContent.length > 0) {
                const snippet = highlightSrtContent.substring(0, Math.min(200, highlightSrtContent.length));
                logger.debug(`SRT Snippet for highlight ${highlightIndex}: ${snippet}...`);
              }
            } else {
              logger.debug(`No subtitles found for highlight ${highlightIndex}. Creating empty SRT file.`);
              await fs.writeFile(srtOutputPath, "");
            }
          } else {
            logger.warn(
              `Could not parse adjusted timestamps for highlight ${highlightIndex}, skipping SRT generation.`
            );
          }
        } catch (srtError) {
          logger.error(
            `Failed to generate SRT for highlight ${highlightIndex}: ${srtError.message}`
          );
        }
      } else {
        logger.warn(
          `Skipping SRT generation for highlight ${highlightIndex} (full SRT not processed).`
        );
      }

      await fs.writeFile(
        descPath,
        `Original Timestamp: ${highlight.startTime} - ${highlight.endTime}\n` +
          `Adjusted Timestamp: ${adjustedStartTime} - ${adjustedEndTime}\n` +
          `Description: ${highlight.text || "N/A"}\n` +
          `Score: ${highlight.score.toFixed(2)}`
      );

      logger.info(`Highlight ${highlightIndex} processed successfully.`);
      
      // Call progress callback if provided
      if (typeof progressCallback === 'function') {
        progressCallback(highlightIndex);
      }
    } catch (error) {
      logger.error(
        `Failed to process highlight ${highlightIndex}: ${error.message}`
      );
    }
  }
  
  logger.info(`Downloaded ${downloadedFiles.length} highlight videos`);
  return downloadedFiles;
}

async function downloadSegment(url, startTime, endTime, outputPath, highlightIndex, options = {}) {
  const {
    quality = 'default',
    format = 'mp4',
  } = options;
  
  // Map quality settings to yt-dlp format strings
  const qualityFormats = {
    low: "worst[ext=mp4]/worst", // Lowest quality
    medium: "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/mp4", // Medium quality (480p)
    high: "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/mp4", // High quality (720p)
    best: "best[ext=mp4]/mp4", // Best available quality (default)
    default: "best[ext=mp4]/mp4"
  };

  // Format selection based on requested format and quality
  let formatSelection;
  if (format === 'mp4') {
    formatSelection = qualityFormats[quality] || qualityFormats.default;
  } else {
    // Support custom formats like webm, mkv, etc.
    formatSelection = `bestvideo[ext=${format}]+bestaudio/best[ext=${format}]/${format}`;
  }

  const ytDlpArgs = [
    "-m", "yt_dlp",
    "--no-check-certificate",
    "--cookies", path.join(process.cwd(), "cookies.txt"),
    "--verbose",
    "--progress",
    "--progress-template", "download:%(progress._percent_str)s",
    "-f", formatSelection,
    "--download-sections", `*${startTime}-${endTime}`,
    "-o", outputPath,
    url,
  ];

  logger.debug(`Executing yt-dlp download command`, {
    command: `python ${ytDlpArgs.join(" ")}`,
    highlightIndex,
    quality,
    format
  });
  
  // Overwrite file if it exists from a previous failed attempt for this segment
  if (await fs.pathExists(outputPath)) {
    await fs.remove(outputPath);
  }

  return new Promise((resolve, reject) => {
    const process = spawn("python", ytDlpArgs);
    let lastReportedProgress = "";

    process.stdout.on("data", (data) => {
      const output = data.toString().trim();
      // Expected output from template: "download:  X.X%"
      if (output.startsWith("download:")) {
        const progress = output.substring("download:".length).trim();
        if (progress !== lastReportedProgress) {
          lastReportedProgress = progress;
          // Update the same line in console for progress
          // Using process.stdout.write for cleaner single-line progress updates
          // Ensure your terminal supports carriage returns for this to work perfectly.
          // Fallback to console.log if process.stdout.write causes issues.
          // process.stdout.write(`  [Highlight ${highlightIndex}] Download Progress: ${progress}                 \r`);
          logger.debug(`Download progress for highlight ${highlightIndex}: ${progress}`);
        }
      }
    });

    let errorOutput = "";
    process.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    process.on("close", async (code) => {
      // process.stdout.write("\n"); // New line after progress finishes if using process.stdout.write
      if (code === 0) {
        try {
          // Check if file exists and is not empty
          if (!(await fs.pathExists(outputPath))) {
            return reject(new Error(`[Highlight ${highlightIndex}] Download failed: Output file ${outputPath} not found.`));
          }
          const stats = await fs.stat(outputPath);
          if (stats.size > 1024) { // Check if file size is > 1KB
            logger.info(`Download complete for highlight ${highlightIndex}`, {
              file: outputPath,
              size: stats.size,
              timeRange: `${startTime}-${endTime}`
            });
            resolve(outputPath);
          } else {
            await fs.remove(outputPath); // Remove empty/corrupt file
            reject(new Error(`[Highlight ${highlightIndex}] Download failed: Output file too small (${stats.size} bytes).`));
          }
        } catch (error) {
          reject(error);
        }
      } else {
        logger.error(`Download process exited with code ${code}`, {
          highlightIndex,
          errorOutput: errorOutput.substring(0, 500) // Only show first 500 chars of error
        });
        reject(new Error(`[Highlight ${highlightIndex}] yt-dlp exited with code ${code}.`));
      }
    });
  });
}

// Function to get video information using yt-dlp
export async function getVideoInfo(url) {
  const videoId = getYoutubeVideoId(url);
  if (!videoId) {
    throw new Error(`Could not extract video ID from URL: ${url}`);
  }
  
  // Check cache first
  if (videoMetadataCache[videoId]) {
    logger.info(`Loading video metadata from cache for ${videoId}`);
    return videoMetadataCache[videoId];
  }
  
  logger.info(`Retrieving video metadata for ${videoId}`);
  try {
    // On Windows, we need to handle % characters differently
    const isWindows = process.platform === 'win32';
    let command;
    
    if (isWindows) {
      // For Windows, use separate commands for each piece of info
      const idCommand = `python -m yt_dlp --no-check-certificate --cookies "${path.join(process.cwd(), "cookies.txt")}" --skip-download --print id ${url}`;
      const titleCommand = `python -m yt_dlp --no-check-certificate --cookies "${path.join(process.cwd(), "cookies.txt")}" --skip-download --print title ${url}`;
      const durationCommand = `python -m yt_dlp --no-check-certificate --cookies "${path.join(process.cwd(), "cookies.txt")}" --skip-download --print duration ${url}`;
      const uploaderCommand = `python -m yt_dlp --no-check-certificate --cookies "${path.join(process.cwd(), "cookies.txt")}" --skip-download --print uploader ${url}`;
      
      const { stdout: idOutput } = await execPromise(idCommand);
      const { stdout: titleOutput } = await execPromise(titleCommand);
      const { stdout: durationOutput } = await execPromise(durationCommand);
      const { stdout: uploaderOutput } = await execPromise(uploaderCommand);
      
      const videoInfo = {
        id: idOutput.trim(),
        title: titleOutput.trim() || "Unknown Title",
        duration: parseInt(durationOutput.trim()) || 0,
        uploader: uploaderOutput.trim() || "Unknown Uploader"
      };
      
      // Update cache
      videoMetadataCache[videoId] = videoInfo;
      await saveVideoMetadataCache();
      
      return videoInfo;
    } else {
      // For Unix systems, we can use the original approach
      const ytDlpArgs = [
        "-m", "yt_dlp",
        "--no-check-certificate",
        "--cookies", path.join(process.cwd(), "cookies.txt"),
        "--print", "%(id)s|%(title)s|%(duration)s|%(uploader)s",
        "--skip-download",
        url
      ];
      
      const { stdout } = await execPromise(`python ${ytDlpArgs.join(" ")}`);
      const [id, title, duration, uploader] = stdout.trim().split("|");
      
      const videoInfo = {
        id,
        title: title || "Unknown Title",
        duration: duration ? parseInt(duration) : 0,
        uploader: uploader || "Unknown Uploader"
      };
      
      // Update cache
      videoMetadataCache[videoId] = videoInfo;
      await saveVideoMetadataCache();
      
      return videoInfo;
    }
  } catch (error) {
    logger.error(`Failed to retrieve video info`, error);
    throw new Error(`Failed to retrieve video information: ${error.message}`);
  }
}
