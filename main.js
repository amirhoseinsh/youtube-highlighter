import { program } from 'commander';
import { processVideo } from './lib/processor.js';
import fs from 'fs-extra';
import path from 'path';
import logger from "./lib/logger.js";
import configManager from './lib/config.js';

// Ensure required directories exist
function sanitizePromptForDirectory(prompt) {
  if (!prompt || typeof prompt !== 'string') {
    return 'general_prompt';
  }
  return prompt
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .replace(/[^\w-]+/g, ''); // Remove non-alphanumeric characters except hyphens and underscores
}

function ensureDirectories() {
  try {
    const downloadsDir = path.join(process.cwd(), 'downloads');
    const tempDir = path.join(process.cwd(), 'temp');
    fs.ensureDirSync(downloadsDir);
    fs.ensureDirSync(tempDir);
    logger.debug('Created required directories', { downloadsDir, tempDir });
  } catch (err) {
    logger.error('Failed to create required directories', err);
    throw err;
  }
}

function getCurrentDateFormatted() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0'); // Months are 0-indexed
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getNextProjectFolderName(baseDownloadsPath) {
  const todayDateStr = getCurrentDateFormatted();
  let projectCounter = 1;
  fs.ensureDirSync(baseDownloadsPath);
  try {
    const existingEntries = fs.readdirSync(baseDownloadsPath);
    const todayProjectFolders = existingEntries.filter(entry => {
      try {
        const entryPath = path.join(baseDownloadsPath, entry);
        return fs.statSync(entryPath).isDirectory() && entry.startsWith(todayDateStr + '_project_');
      } catch (statError) {
        logger.debug(`Error accessing entry ${entry}`, statError);
        return false;
      }
    });
    if (todayProjectFolders.length > 0) {
      const existingCounters = todayProjectFolders.map(folderName => {
        const parts = folderName.split('_project_');
        return parseInt(parts[1], 10);
      }).filter(num => !isNaN(num));
      if (existingCounters.length > 0) {
        projectCounter = Math.max(...existingCounters) + 1;
      }
    }
  } catch (readDirError) {
    logger.warn(`Could not read downloads directory to determine project counter`, readDirError);
  }
  const projectFolderName = `${todayDateStr}_project_${projectCounter}`;
  return path.join(baseDownloadsPath, projectFolderName);
}

// Load configuration before setting up the CLI
configManager.load();

// Define the main command
program
  .name("youtube-highlighter")
  .description("Extract highlight moments from YouTube videos")
  .version("1.0.0")
  .requiredOption("-u, --url <url>", "YouTube video URL")
  .option('-k, --api-key <key>', 'Groq API key', configManager.get('apiKey', ''))
  .option('-p, --prompt <prompt>', 'Prompt for highlight detection (e.g., "funny moments")')
  .option('-n, --num-highlights <number>', 'Number of highlights to extract', configManager.get('highlights.defaultCount', '5').toString())
  .option('-d, --duration <minutes>', 'Approximate duration of each highlight in minutes', configManager.get('highlights.defaultDuration', '2').toString())
  .option('--log-level <level>', 'Log level (debug, info, warn, error, none)', configManager.get('logLevel', 'info'))
  .option('--retry-count <number>', 'Number of retries for failed API calls', configManager.get('performance.retryCount', '3').toString())
  .option('--config <path>', 'Path to custom configuration file')
  .option('--save-config', 'Save current settings as default configuration')
  .option('--detailed-metadata', 'Include detailed metadata in output files', configManager.get('outputFormat.includeDetailedMetadata', false))
  .option('--generate-thumbnails', 'Generate preview thumbnails for highlights', configManager.get('outputFormat.generateThumbnails', false))
  .option('--thumbnail-quality <quality>', 'Thumbnail quality (low, medium, high)', configManager.get('outputFormat.thumbnailQuality', 'medium'))
  .option('--no-progress-bar', 'Disable progress bar in CLI', !configManager.get('ui.showProgressBar', true));

program.parse(process.argv);
const options = program.opts();

// Load custom config if specified
if (options.config) {
  const customConfigManager = new ConfigManager(options.config);
  customConfigManager.load();
  Object.assign(configManager.config, customConfigManager.config);
}

// Save configuration if requested
if (options.saveConfig) {
  // Update config with CLI options
  if (options.apiKey) configManager.set('apiKey', options.apiKey);
  if (options.logLevel) configManager.set('logLevel', options.logLevel);
  if (options.retryCount) configManager.set('performance.retryCount', parseInt(options.retryCount, 10));
  if (options.numHighlights) configManager.set('highlights.defaultCount', parseInt(options.numHighlights, 10));
  if (options.duration) configManager.set('highlights.defaultDuration', parseInt(options.duration, 10));
  configManager.set('outputFormat.includeDetailedMetadata', !!options.detailedMetadata);
  configManager.set('outputFormat.generateThumbnails', !!options.generateThumbnails);
  if (options.thumbnailQuality) configManager.set('outputFormat.thumbnailQuality', options.thumbnailQuality);
  configManager.set('ui.showProgressBar', options.progressBar !== false);
  
  // Save to file
  if (configManager.save()) {
    logger.info(`Configuration saved to ${configManager.configPath}`);
  }
}

// Set log level
logger.setLogLevel(options.logLevel?.toUpperCase() || 'INFO');

logger.info(`Starting YouTube Highlighter`, { 
  url: options.url, 
  highlights: options.numHighlights, 
  duration: options.duration
});

async function main() {
  try {
    ensureDirectories();

    const downloadsDir = path.join(process.cwd(), 'downloads');
    // Get the unique project path for this run, e.g., 'downloads/YYYY-MM-DD_project_N'
    const projectBasePath = getNextProjectFolderName(downloadsDir);
    fs.ensureDirSync(projectBasePath); // Create the unique project folder

    logger.info('Starting highlight extraction process...');
    logger.info(`Project folder: ${projectBasePath}`);

    const sanitizedPrompt = sanitizePromptForDirectory(options.prompt);
    // The prompt-specific folder is now INSIDE the projectBasePath
    const promptSpecificPath = path.join(projectBasePath, sanitizedPrompt);
    fs.ensureDirSync(promptSpecificPath); // Create, e.g., 'downloads/PROJECT_NAME/funny_moments'
    
    logger.info('Processing video', {
      url: options.url,
      prompt: options.prompt,
      outputFolder: promptSpecificPath
    });
    
    try {
      const result = await processVideo({
        url: options.url,
        prompt: options.prompt, // Original prompt for AI
        apiKey: options.apiKey,
        numHighlights: parseInt(options.numHighlights),
        duration: parseInt(options.duration),
        minSeconds: parseInt(options.duration) * 60, // Convert minutes to seconds
        outputBasePath: promptSpecificPath, // This is now 'downloads/PROJECT_NAME/PROMPT_NAME/'
        retryOptions: {
          maxRetries: parseInt(options.retryCount),
          initialDelayMs: 1000,
          maxDelayMs: 30000
        },
        outputOptions: {
          includeDetailedMetadata: !!options.detailedMetadata,
          generateThumbnails: !!options.generateThumbnails,
          thumbnailQuality: options.thumbnailQuality || 'medium'
        },
        uiOptions: {
          showProgressBar: options.progressBar !== false
        }
      });
      
      logger.info('Highlight extraction completed successfully!');
      logger.info(`Check the "${projectBasePath.replace(process.cwd() + path.sep, '')}" directory for your project files.`);

      if (result?.videoInfo) {
        logger.info(`Video details: "${result.videoInfo.title}"`, { 
          duration: result.videoInfo.duration, 
          id: result.videoInfo.id 
        });
      }

      if (result?.highlights) {
        logger.info(`Extracted ${result.highlights.length} highlights`);
      }
    } catch (processingError) {
      logger.error('Error processing video', processingError);
      throw processingError;
    }
  } catch (error) {
    logger.error("An error occurred during processing", error);
    process.exit(1);
  }
}

main();
