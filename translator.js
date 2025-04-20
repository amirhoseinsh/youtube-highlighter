import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
} from "@google/generative-ai";
import fs from "fs/promises"; // Use promises version for async/await
import path from "path";
import SRTParser2 from "srt-parser-2"; // Import the default exportimport dotenv from "dotenv";
import dotenv from "dotenv"; // <-- Add this line
// Load environment variables from .env file
dotenv.config();

// --- Configuration ---
const API_KEY = process.env.GEMINI_API_KEY;
// Use a standard, readily available model. Flash is fast and capable.
// Or use "gemini-pro" for the stable general model.
const MODEL_NAME = "gemini-1.5-flash-latest";
const TARGET_LANGUAGE = "Persian"; // Target language (e.g., Persian, French, Spanish)
const OUTPUT_SUFFIX = "_fa"; // Suffix for the translated file (e.g., _fa, _fr, _es)
const DELAY_BETWEEN_REQUESTS_MS = 4000; // Delay to avoid hitting free tier rate limits (~60 RPM)
const MAX_RETRIES = 2; // Max retries for a failed API call
const RETRY_DELAY_MS = 2000; // Delay before retrying a failed call

// Safety settings for the Gemini API (adjust if needed)
const safetySettings = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
];

// Generation configuration (optional, tune if needed)
const generationConfig = {
  temperature: 0.7, // Controls randomness (lower = more predictable)
  topK: 1,
  topP: 1,
  maxOutputTokens: 2048, // Max tokens per response
};
// --- End Configuration ---

// --- Helper Functions ---
async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function constructPrompt(text, targetLanguage) {
  // Kept your detailed prompt structure
  return `Translate the following English text to ${targetLanguage} for use in subtitles.

**Translation Guidelines:**
1.  **Fluency (روان و بدون تپق):** The translation must be fluent, natural-sounding, and avoid awkward phrasing or repetition specific to ${targetLanguage}.
2.  **Conciseness (خلاصه و خوانا):** Keep the translation concise and easy to read quickly on screen, suitable for ${targetLanguage} subtitles. Avoid overly long sentences.
3.  **Coherence (حفظ انسجام):** Ensure the translation maintains the meaning and flow, fitting naturally with potential surrounding dialogue in ${targetLanguage}.
4.  **Accuracy (حفظ معنا):** Accurately convey the original meaning of the text. Do not add or remove information.

**Text to Translate:**
"${text}"

**${targetLanguage} Translation:`;
}

// --- Main Translation Function ---
async function translateSrtFile(inputFilePath, targetLanguage, outputSuffix) {
  console.log(`\n--- Starting Translation ---`);
  console.log(`Input File:      ${inputFilePath}`);
  console.log(`Target Language: ${targetLanguage}`);

  // --- 1. Validate Input Path ---
  try {
    await fs.access(inputFilePath); // Check if file exists and is accessible
  } catch (err) {
    console.error(
      `❌ Error: Input file not found or inaccessible at ${inputFilePath}`
    );
    process.exit(1);
  }
  if (path.extname(inputFilePath).toLowerCase() !== ".srt") {
    console.error(`❌ Error: Input file must be an .srt file.`);
    process.exit(1);
  }

  const outputFilePath = inputFilePath.replace(
    /\.srt$/i,
    `${outputSuffix}.srt`
  );
  console.log(`Output File:     ${outputFilePath}`);
  console.log(`----------------------------`);

  // --- 2. Initialize Gemini Client ---
  if (!API_KEY) {
    console.error(
      "❌ Error: GEMINI_API_KEY not found in environment variables."
    );
    console.error("   Please create a .env file with your API key.");
    process.exit(1);
  }
  const genAI = new GoogleGenerativeAI(API_KEY);
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    safetySettings,
    generationConfig,
  });

  // --- 3. Read and Parse SRT ---
  let srtContent;
  let subtitles = [];
  const parser = new SRTParser2(); // Instantiate the parser correctly

  try {
    srtContent = await fs.readFile(inputFilePath, "utf-8");
    subtitles = parser.fromSrt(srtContent);
    if (!subtitles || subtitles.length === 0) {
      console.error(
        "⚠️ Warning: SRT file is empty or could not be parsed correctly."
      );
      // Create an empty output file? Or exit? Let's create empty.
      await fs.writeFile(outputFilePath, "", "utf-8");
      console.log(`✅ Empty output file created at ${outputFilePath}`);
      return; // Stop processing
    }
    console.log(`ℹ️ Parsed ${subtitles.length} subtitle entries.`);
  } catch (err) {
    console.error(`❌ Error reading or parsing SRT file: ${err.message}`);
    process.exit(1);
  }

  // --- 4. Translate Each Subtitle Entry ---
  const translatedSubtitles = [];
  let successfulTranslations = 0;
  let failedTranslations = 0;

  console.log(`\n🚀 Starting translation requests (using ${MODEL_NAME})...`);

  for (let i = 0; i < subtitles.length; i++) {
    const sub = subtitles[i];
    const originalText = sub.text.trim(); // Trim whitespace

    // Keep empty/whitespace-only lines as is
    if (!originalText) {
      translatedSubtitles.push({ ...sub, text: "" });
      // console.log(`  -> Segment ${sub.id}: Skipped (empty)`); // Optional: Log skips
      continue;
    }

    const prompt = constructPrompt(originalText, targetLanguage);
    let translatedText = null;
    let attempt = 0;
    let success = false;

    while (attempt <= MAX_RETRIES && !success) {
      if (attempt > 0) {
        console.log(
          `  Retrying segment ${sub.id} (Attempt ${attempt + 1}/${
            MAX_RETRIES + 1
          })...`
        );
        await delay(RETRY_DELAY_MS * attempt); // Exponential backoff could be added
      }

      try {
        if (attempt === 0) {
          console.log(
            `  Translating segment ${sub.id} / ${subtitles.length}...`
          );
        }
        const result = await model.generateContent(prompt);
        const response = result.response; // No need for await here

        // --- Safer response extraction ---
        const candidate = response?.candidates?.[0];
        if (candidate?.finishReason && candidate.finishReason !== "STOP") {
          throw new Error(
            `API call finished unexpectedly: ${candidate.finishReason}. Content may be blocked or incomplete.`
          );
        }
        const text = candidate?.content?.parts?.[0]?.text;
        // --- End safer response extraction ---

        if (text && text.trim()) {
          translatedText = text.trim();
          success = true;
          successfulTranslations++;
          if (attempt === 0) {
            // Only log details on first success
            console.log(`    Original:   ${originalText.replace(/\n/g, " ")}`);
            console.log(
              `    Translated: ${translatedText.replace(/\n/g, " ")}`
            );
          } else {
            console.log(`  Segment ${sub.id} succeeded on retry.`);
          }
        } else {
          // Throw error if text is empty or missing after API call
          throw new Error("API returned empty or invalid translation content.");
        }
      } catch (error) {
        console.error(
          `  ❌ Error translating segment ${sub.id} (Attempt ${attempt + 1}): ${
            error.message
          }`
        );
        failedTranslations++; // Count failure on the *first* error for a segment
        if (attempt === MAX_RETRIES) {
          console.warn(
            `  ⚠️ Giving up on segment ${sub.id} after ${
              MAX_RETRIES + 1
            } attempts. Keeping original text.`
          );
          console.warn(`     Original text: "${originalText}"`);
          translatedText = originalText; // Fallback to original
          break; // Exit retry loop for this segment
        }
      }
      attempt++;
    } // End retry while loop

    translatedSubtitles.push({ ...sub, text: translatedText ?? originalText }); // Use translated or fallback

    // Add delay between requests, even after failures/retries
    if (i < subtitles.length - 1) {
      await delay(DELAY_BETWEEN_REQUESTS_MS);
    }
  } // End loop through subtitles

  console.log("\n--- Translation Summary ---");
  console.log(`Total Segments:      ${subtitles.length}`);
  console.log(`Successful (API):    ${successfulTranslations}`);
  console.log(
    `Failed (used orig):  ${failedTranslations > 0 ? failedTranslations : 0}`
  ); // Only count segments that ultimately failed
  console.log(`---------------------------`);

  // --- 5. Build and Write Output SRT ---
  try {
    const translatedSrtContent = parser.toSrt(translatedSubtitles);
    await fs.writeFile(outputFilePath, translatedSrtContent, "utf-8");
    console.log(`\n✅ Successfully translated and saved to ${outputFilePath}`);
  } catch (err) {
    console.error(`❌ Error writing output file: ${err.message}`);
  }
}

// --- Script Execution ---
async function main() {
  const inputFile = process.argv[2]; // Get input file path from command line argument

  if (!inputFile) {
    console.error("Usage: node translator.js <path_to_your_input.srt>");
    console.error("Example: node translator.js ./subs/my_video.srt");
    process.exit(1);
  }

  try {
    // Construct the absolute path regardless of input type
    const absoluteInputPath = path.resolve(inputFile);
    await translateSrtFile(absoluteInputPath, TARGET_LANGUAGE, OUTPUT_SUFFIX);
  } catch (error) {
    // Catch any unexpected errors during the main process
    console.error(
      "\n❌ An unexpected error occurred during the script execution:",
      error
    );
    process.exit(1);
  }
}

// Run the main asynchronous function
main();
