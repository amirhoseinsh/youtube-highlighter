import { program } from 'commander';
import { processVideo } from './lib/processor.js';
import fs from 'fs-extra';
import path from 'path';

// Ensure required directories exist
const ensureDirectories = () => {
  fs.ensureDirSync(path.join(process.cwd(), 'downloads'));
  fs.ensureDirSync(path.join(process.cwd(), 'temp'));
};

program
  .name('youtube-highlight-extractor')
  .description('Extract highlight moments from YouTube videos using subtitle analysis')
  .requiredOption('-u, --url <url>', 'YouTube video URL')
  .requiredOption('-k, --api-key <key>', 'Groq API key')
  .option('-n, --num-highlights <number>', 'Number of highlights to extract', '5')
  .option('-d, --duration <minutes>', 'Approximate duration of each highlight in minutes', '2');

program.parse();

const options = program.opts();

async function main() {
  try {
    ensureDirectories();
    
    console.log('Starting highlight extraction process...');
    console.log(`Video URL: ${options.url}`);
    console.log(`Prompt: ${options.prompt}`);
    
    await processVideo({
      url: options.url,
      prompt: options.prompt,
      apiKey: options.apiKey,
      numHighlights: parseInt(options.numHighlights),
      duration: parseInt(options.duration),
      minSeconds: parseInt(options.duration) * 60, // Convert minutes to seconds
    });
    
    console.log('Highlight extraction completed successfully!');
    console.log('Check the "downloads" directory for your highlight videos.');
  } catch (error) {
    console.error('Error during highlight extraction:', error.message);
    process.exit(1);
  }
}

main();
