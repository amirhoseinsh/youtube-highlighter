# YouTube Highlight Extractor Narges Version

A CLI tool that extracts highlight moments from YouTube videos using subtitle analysis with Groq AI and yt-dlp.

## Prerequisites

1. Node.js (v16 or higher)
2. Python 3.x
3. yt-dlp Python package
4. Groq API key

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

## Usage

```bash
node main.js --url "https://www.youtube.com/watch?v=VIDEO_ID" \
             --prompt "most viral moments" \
             --api-key "your-groq-api-key" \
             --num-highlights 5 \
             --duration 2
```

### Options

- `-u, --url`: YouTube video URL (required)
- `-p, --prompt`: Prompt for highlight detection (e.g., "most viral moments") (required)
- `-k, --api-key`: Groq API key (required)
- `-n, --num-highlights`: Number of highlights to extract (default: 5)
- `-d, --duration`: Approximate duration of each highlight in minutes (default: 2)

### Output

The tool will:
1. Download video subtitles
2. Analyze them with Groq AI (using llama-4-maverick-17b-128e-instruct model) to identify highlight moments
3. Download the highlight segments
4. Save them in the `downloads` directory with corresponding description files

Each highlight will be saved as:
- `highlight_N.mp4`: The video segment
- `highlight_N_description.txt`: Timestamp and description of the highlight

## Example

```bash
node main.js \
  --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" \
  --prompt "funny moments" \
  --api-key "your-groq-api-key" \
  --num-highlights 3
```

## Error Handling

The tool includes error handling for:
- Invalid YouTube URLs
- Missing or incorrect API keys
- Failed subtitle downloads
- Failed video segment downloads
- Invalid Groq API responses

Check the error messages for troubleshooting guidance.

## Dependencies

- commander: CLI argument parsing
- axios: HTTP requests
- subtitle: SRT file parsing
- fs-extra: Enhanced file system operations
- yt-dlp: YouTube video and subtitle downloading
