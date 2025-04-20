export function formatSrtTimestamp(milliseconds) {
  // ms to SRT Time (HH:MM:SS,ms)
  if (milliseconds === null || isNaN(milliseconds)) return "00:00:00,000";
  const totalSeconds = milliseconds / 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const ms = Math.round(milliseconds % 1000);
  return `${padZero(hours)}:${padZero(minutes)}:${padZero(seconds)},${String(
    ms
  ).padStart(3, "0")}`;
}

export function parseTimestampHMS(hmsString) {
  // HH:MM:SS to ms
  try {
    const parts = hmsString.split(":").map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    const [hours, minutes, seconds] = parts;
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
  } catch (e) {
    return null;
  }
}

export function parseSrt(srtContent, filePathForLogging = "parsed content") {
  if (!srtContent || typeof srtContent !== "string") {
    console.error(
      `[parseSrt] Received invalid content for ${filePathForLogging}`
    );
    return [];
  }
  // Normalize line endings and split by double newlines (one or more)
  const blocks = srtContent.replace(/\r\n/g, "\n").trim().split(/\n\n+/);
  const subtitles = [];
  let skippedBlocks = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const lines = block.trim().split("\n");
    if (lines.length < 2) {
      skippedBlocks++;
      continue;
    } // Need timestamp and text

    let timecodeLine = "";
    let textLinesStartIndex = -1;

    // Find the line containing ' --> '
    for (let j = 0; j < lines.length; j++) {
      if (lines[j].includes(" --> ")) {
        timecodeLine = lines[j];
        textLinesStartIndex = j + 1;
        break;
      }
    }

    if (
      !timecodeLine ||
      textLinesStartIndex === -1 ||
      textLinesStartIndex > lines.length
    ) {
      skippedBlocks++;
      // console.warn(`[parseSrt] Block ${i+1} skipped in ${filePathForLogging}: No valid timecode/text found.`);
      continue;
    }

    const timecodeParts = timecodeLine.split(" --> ");
    if (timecodeParts.length !== 2 || !timecodeParts[0] || !timecodeParts[1]) {
      skippedBlocks++;
      // console.warn(`[parseSrt] Block ${i+1} skipped in ${filePathForLogging}: Invalid timecode split.`);
      continue;
    }

    const startTime = parseTimestamp(timecodeParts[0]);
    const endTime = parseTimestamp(timecodeParts[1]);
    const text = lines.slice(textLinesStartIndex).join(" ").trim();

    if (
      startTime !== null &&
      endTime !== null &&
      text &&
      startTime <= endTime
    ) {
      subtitles.push({ start: startTime, end: endTime, text });
    } else {
      skippedBlocks++;
      // console.warn(`[parseSrt] Block ${i+1} skipped in ${filePathForLogging}: Invalid data after parse.`);
    }
  }

  if (subtitles.length === 0 && blocks.length > 0) {
    console.error(
      `[parseSrt] CRITICAL: Processed ${blocks.length} blocks from ${filePathForLogging} but extracted 0 valid subtitles. Please MANUALLY INSPECT the saved file.`
    );
  }
  return subtitles;
}
