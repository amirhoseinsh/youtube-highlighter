// ./lib/processor.js
import { downloadSubtitles } from "./srt-utils.js";
import { repunctuate } from "./repunctuate.js";
import { classifySentences } from "./question-classifier.js";
import { buildBlocks } from "./build-blocks.js";
import { scoreSegments } from "./groq-scorer.js";
import { downloadHighlights, getVideoInfo, generateThumbnail } from "./video-utils.js";
import logger from "./logger.js";
import cliProgress from 'cli-progress';
import colors from 'ansi-colors';

import fs from "fs-extra";
import path from "path";

/* ---------- helper: save master highlights SRT ---------- */
async function saveHighlightsSrt(list, outDir, baseFilename = "highlights.srt") {
  if (!list.length) return;
  try {
    const blocks = list.map(
      (h, i) =>
        `${i + 1}\n${h.startTime},000 --> ${h.endTime},000\nScore ${h.score}\n`
    );
    const file = path.join(outDir, baseFilename);
    await fs.writeFile(file, blocks.join("\n"));
    logger.info(`Highlights SRT saved to ${file}`);
    return file;
  } catch (error) {
    logger.error(`Failed to save highlights SRT file`, error);
    throw error;
  }
}

/**
 * Save detailed metadata about the highlights and processing
 * @param {Object} data - Highlight and processing data
 * @param {string} outputDir - Output directory path
 * @returns {Promise<string>} - Path to saved file
 */
async function saveDetailedMetadata(data, outputDir) {
  try {
    const metadataFile = path.join(outputDir, 'highlights-metadata.json');
    await fs.writeJson(metadataFile, data, { spaces: 2 });
    logger.info(`Detailed metadata saved to ${metadataFile}`);
    return metadataFile;
  } catch (error) {
    logger.error(`Failed to save detailed metadata`, error);
    throw error;
  }
}

// Performance configuration
const PERFORMANCE_CONFIG = {
  maxTokensPerBlock: 1024, // Maximum tokens per block for efficient processing
  parallelProcessing: true, // Enable parallel processing
  maxConcurrentRequests: 3, // Maximum concurrent requests for API calls
};

/* ------------------------- main ------------------------- */
export async function processVideo({ 
  url, 
  prompt, 
  apiKey, 
  numHighlights = 5, 
  minSeconds = 60, 
  outputBasePath,
  retryOptions = {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000
  },
  performanceConfig = PERFORMANCE_CONFIG,
  outputOptions = {
    includeDetailedMetadata: false,
    generateThumbnails: false,
    thumbnailQuality: 'medium'
  },
  videoOptions = {
    quality: 'high',          // low, medium, high, best
    format: 'mp4',           // mp4, webm, mkv, etc. 
    smartTrimming: true      // avoid cutting in the middle of sentences
  },
  uiOptions = {
    showProgressBar: true
  }
}) {
  if (!outputBasePath) {
    throw new Error("[processVideo] outputBasePath is required but was not provided.");
  }
  
  // Create progress bar objects
  let multiBar;
  let progressBars = {};
  
  if (uiOptions.showProgressBar) {
    multiBar = new cliProgress.MultiBar({
      clearOnComplete: false,
      hideCursor: true,
      format: '{bar} | {task} | {percentage}% | {value}/{total} {unit}'
    }, cliProgress.Presets.shades_classic);
  }
  
  // Helper to create or update progress bar
  const updateProgress = (task, value, total, unit = 'steps') => {
    if (!uiOptions.showProgressBar || !multiBar) return;
    
    if (!progressBars[task]) {
      progressBars[task] = multiBar.create(total, value, {
        task: task.padEnd(20),
        unit,
        percentage: 0
      });
    } else {
      progressBars[task].update(value);
    }
  };
  
  // Process data object to collect all stats and metadata
  const processData = {
    timestamp: new Date().toISOString(),
    videoInfo: null,
    processingConfig: {
      prompt,
      numHighlights,
      minSeconds,
      performanceConfig,
      outputOptions,
      videoOptions
    },
    stats: {
      processingTimeMs: 0,
      totalSentences: 0,
      questions: 0,
      answers: 0,
      other: 0,
      candidateBlocks: 0,
      finalHighlights: 0
    },
    files: {
      subtitles: '',
      highlightsSrt: '',
      thumbnails: [],
      outputVideos: [],
      metadataFile: ''
    },
    highlights: []
  };
  
  const startTime = Date.now();
  
  try {
    /* 0. Get video information */
    logger.info("Retrieving video information");
    updateProgress('Video Info', 0, 1);
    const videoInfo = await getVideoInfo(url);
    processData.videoInfo = videoInfo;
    updateProgress('Video Info', 1, 1);
    
    logger.info(`Processing video: "${videoInfo.title}"`, {
      id: videoInfo.id,
      duration: videoInfo.duration
    });
    
    /* 1. download & parse subtitles */
    logger.info("Downloading subtitles");
    updateProgress('Subtitles', 0, 1);
    const { subtitles, savedSrtPath, videoSpecificOutputDir } = await downloadSubtitles(url, outputBasePath);
    processData.files.subtitles = savedSrtPath;
    updateProgress('Subtitles', 1, 1);
    
    logger.debug(`Downloaded subtitles with ${subtitles.length} entries`);

    /* 2. re‑punctuate + sentence split */
    logger.info("Re-punctuating subtitles");
    updateProgress('Repunctuating', 0, 1);
    const sentences = repunctuate(subtitles); // local
    processData.stats.totalSentences = sentences.length;
    updateProgress('Repunctuating', 1, 1);
    
    logger.debug(`Created ${sentences.length} sentences after punctuation`);

    /* 3. label each sentence Q / A / O */
    logger.info("Classifying sentences (Q/A/Other)");
    updateProgress('Classification', 0, sentences.length);
    
    const cleanSentences = sentences.map((s) => ({
      ...s,
      text: (s.text || '')
        .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, "") // remove timecodes
        .replace(/<c>.*?<\/c>/g, "") // remove caption tags
        .trim(),
    }));
    
    // Track sentence classification progress
    let classificationCounter = 0;
    const classificationCallback = () => {
      classificationCounter++;
      updateProgress('Classification', classificationCounter, sentences.length);
    };
    
    // Pass retry options to downstream functions
    const labeled = await classifySentences(
      cleanSentences, 
      apiKey, 
      retryOptions,
      classificationCallback
    );
    
    const qCount = labeled.filter(s => s.type === 'Q').length;
    const aCount = labeled.filter(s => s.type === 'A').length;
    const oCount = labeled.filter(s => s.type === 'O').length;
    
    processData.stats.questions = qCount;
    processData.stats.answers = aCount;
    processData.stats.other = oCount;
    
    logger.info(`Sentence classification results`, {
      questions: qCount,
      answers: aCount,
      other: oCount,
      total: labeled.length
    });

    /* 4. stitch Q→A blocks ≥ minSeconds with token optimization */
    logger.info("Building candidate blocks");
    updateProgress('Building Blocks', 0, 1);
    const blocks = buildBlocks(
      labeled, 
      minSeconds, 
      5, 
      performanceConfig.maxTokensPerBlock
    );
    processData.stats.candidateBlocks = blocks.length;
    updateProgress('Building Blocks', 1, 1);
    
    logger.info(`Created ${blocks.length} candidate blocks ≥${minSeconds}s`);
    
    if (!blocks.length) {
      const err = new Error("No suitable Q→A blocks found");
      logger.error(err.message);
      throw err;
    }

    /* 5. call Groq to score each block with parallel processing */
    logger.info("Scoring blocks");
    updateProgress('Scoring', 0, blocks.length);
    
    let scoringCounter = 0;
    const scoringCallback = () => {
      scoringCounter++;
      updateProgress('Scoring', scoringCounter, blocks.length);
    };
    
    // Pass retry options to scoring function
    const scored = await scoreSegments(blocks, apiKey, retryOptions, scoringCallback);

    /* 6. take top‑N (non‑overlap already ensured in buildBlocks) */
    const highlights = scored
      .slice(0, numHighlights)
      .map(({ startTime, endTime, score, text }) => ({ 
        startTime, 
        endTime, 
        score,
        text: text.substring(0, 100) + (text.length > 100 ? '...' : '') // Include preview text
      }));
      
    processData.stats.finalHighlights = highlights.length;
    processData.highlights = highlights;

    if (highlights.length < numHighlights) {
      logger.warn(
        `Only ${highlights.length}/${numHighlights} scored blocks available – consider lowering minimum duration or checking sentence labels`
      );
    }

    const srtFile = await saveHighlightsSrt(highlights, videoSpecificOutputDir, "highlights.srt");
    processData.files.highlightsSrt = srtFile;
    
    logger.info(`Downloading ${highlights.length} highlight videos`);
    updateProgress('Downloading', 0, highlights.length);
    
    let downloadCounter = 0;
    const downloadCallback = () => {
      downloadCounter++;
      updateProgress('Downloading', downloadCounter, highlights.length);
    };
    
    const downloadedFiles = await downloadHighlights(
      url, 
      highlights, 
      savedSrtPath, 
      minSeconds, 
      videoSpecificOutputDir, 
      downloadCallback,
      videoOptions
    );
    
    processData.files.outputVideos = downloadedFiles;

    // Generate thumbnails if requested
    if (outputOptions.generateThumbnails) {
      logger.info(`Generating ${highlights.length} thumbnails`);
      updateProgress('Thumbnails', 0, highlights.length);
      
      const thumbnailPromises = highlights.map(async (highlight, index) => {
        const videoFilePath = downloadedFiles[index];
        if (!videoFilePath) return null;
        
        try {
          const thumbnailPath = await generateThumbnail(
            videoFilePath, 
            videoSpecificOutputDir,
            outputOptions.thumbnailQuality
          );
          
          updateProgress('Thumbnails', index + 1, highlights.length);
          return thumbnailPath;
        } catch (thumbnailError) {
          logger.warn(`Failed to generate thumbnail for highlight ${index + 1}`, thumbnailError);
          return null;
        }
      });
      
      const thumbnailPaths = await Promise.all(thumbnailPromises);
      processData.files.thumbnails = thumbnailPaths.filter(Boolean);
    }

    // Save detailed metadata if requested
    if (outputOptions.includeDetailedMetadata) {
      processData.stats.processingTimeMs = Date.now() - startTime;
      const metadataPath = await saveDetailedMetadata(processData, videoSpecificOutputDir);
      processData.files.metadataFile = metadataPath;
    }

    logger.info("All highlights processed successfully");
    
    // Stop progress bars
    if (multiBar) {
      multiBar.stop();
    }
    
    // Return comprehensive result object
    return {
      videoInfo,
      highlights,
      stats: {
        totalSentences: sentences.length,
        questions: qCount,
        answers: aCount,
        other: oCount,
        candidateBlocks: blocks.length,
        finalHighlights: highlights.length,
        processingTimeMs: Date.now() - startTime
      },
      files: {
        subtitles: savedSrtPath,
        highlightsSrt: srtFile,
        videoOutputDir: videoSpecificOutputDir,
        downloadedVideos: downloadedFiles,
        thumbnails: processData.files.thumbnails || [],
        metadataFile: processData.files.metadataFile || ''
      }
    };
  } catch (error) {
    // Stop progress bars on error
    if (multiBar) {
      multiBar.stop();
    }
    
    logger.error("Error in video processing", error);
    throw error;
  }
}
