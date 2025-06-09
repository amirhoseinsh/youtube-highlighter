# YouTube Highlight Extractor Narges Version

A CLI tool that extracts highlight moments from YouTube videos using subtitle analysis with Groq AI and yt-dlp.

## Prerequisites

1. Node.js (v16 or higher)
2. Python 3.x
3. yt-dlp Python package
4. ffmpeg (for thumbnail generation)
5. Groq API key

## Installation

1. Clone this repository:
```bash
git clone [repository-url]
cd youtube-highlight-extractor
```

2. Install Node.js dependencies:
```bash
npm install
```

3. Install yt-dlp:
```bash
pip install yt-dlp
```

4. Make sure ffmpeg is installed on your system for thumbnail generation

## Usage

```bash
node main.js --url "https://www.youtube.com/watch?v=VIDEO_ID" \
             --api-key "your-groq-api-key" \
             --prompt "most viral moments" \
             --num-highlights 5 \
             --duration 2 \
             --detailed-metadata \
             --generate-thumbnails
```

For a more interactive experience, use the CLI wizard:

```bash
npm run cli
```

### Options

#### Basic Options
- `-u, --url`: YouTube video URL (required)
- `-k, --api-key`: Groq API key (can be saved in config file)
- `-p, --prompt`: Prompt for highlight detection (e.g., "most viral moments")
- `-n, --num-highlights`: Number of highlights to extract (default: 5)
- `-d, --duration`: Approximate duration of each highlight in minutes (default: 2)
- `--log-level`: Log level (debug, info, warn, error, none) (default: info)
- `--retry-count`: Number of retries for failed API calls (default: 3)

#### New User Experience Features
- `--config <path>`: Path to custom configuration file
- `--save-config`: Save current settings as default configuration
- `--detailed-metadata`: Include detailed metadata in output files
- `--generate-thumbnails`: Generate preview thumbnails for highlights
- `--thumbnail-quality <quality>`: Thumbnail quality (low, medium, high)
- `--no-progress-bar`: Disable progress bar in CLI

### Configuration File

The tool now supports persistent configuration through a JSON file located at:
```
~/.youtube-highlighter.json
```

You can create or update this file using the `--save-config` flag, or edit it manually. Example configuration:

```json
{
  "apiKey": "your-groq-api-key",
  "logLevel": "info",
  "outputFormat": {
    "includeDetailedMetadata": true,
    "generateThumbnails": true,
    "thumbnailQuality": "medium"
  },
  "performance": {
    "retryCount": 3,
    "maxConcurrentRequests": 3
  },
  "highlights": {
    "defaultCount": 5,
    "defaultDuration": 2
  },
  "ui": {
    "showProgressBar": true
  }
}
```

### Output

The tool will:
1. Download video subtitles
2. Analyze them with Groq AI (using llama-4-maverick-17b-128e-instruct model) to identify highlight moments
3. Generate thumbnails (if enabled)
4. Download the highlight segments
5. Save detailed metadata (if enabled)

Each highlight will be saved as:
- `highlight_N.mp4`: The video segment
- `highlight_N.srt`: Corresponding subtitles
- `highlight_N.jpg`: Preview thumbnail (if enabled)
- `highlight_N_description.txt`: Timestamp and description of the highlight
- `highlights-metadata.json`: Detailed processing metadata (if enabled)

## Examples

Basic usage:
```bash
node main.js --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --api-key "your-groq-api-key"
```

With enhanced features:
```bash
node main.js --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --api-key "your-groq-api-key" --detailed-metadata --generate-thumbnails
```

Save your settings for future use:
```bash
node main.js --api-key "your-groq-api-key" --num-highlights 3 --detailed-metadata --generate-thumbnails --save-config
```

## Error Handling

The tool includes error handling for:
- Invalid YouTube URLs
- Missing or incorrect API keys
- Failed subtitle downloads
- Failed video segment downloads
- Failed thumbnail generation
- Invalid Groq API responses

Check the error messages for troubleshooting guidance.

## Dependencies

- commander: CLI argument parsing
- axios: HTTP requests
- subtitle: SRT file parsing
- fs-extra: Enhanced file system operations
- cli-progress: Progress bar display
- inquirer: Interactive CLI interface
- yt-dlp: YouTube video and subtitle downloading
- ffmpeg: Thumbnail generation
