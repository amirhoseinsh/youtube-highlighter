#!/usr/bin/env node

import inquirer from "inquirer"; // Use import
import { exec } from "child_process"; // Use import for built-in modules too
import { URL } from "url"; // Import URL class for better validation

// Define the questions to ask the user
const questions = [
  {
    type: "input",
    name: "url",
    message: "Enter the YouTube URL:",
    validate: (value) => {
      try {
        // Use the URL constructor for more robust validation
        new URL(value);
        if (value.startsWith("http://") || value.startsWith("https://")) {
          return true;
        }
        return "URL must start with http:// or https://";
      } catch (error) {
        return "Please enter a valid URL.";
      }
    },
    // default: 'https://www.youtube.com/watch?v=xj8S36h-PcQ&t=2138s'
  },
  {
    type: "password",
    name: "apiKey",
    message: "Enter your API Key (e.g., gsk_...):",
    mask: "*",
    validate: (value) => {
      if (value && value.length > 10) {
        return true;
      }
      return "Please enter your API Key.";
    },
  },
  {
    type: "number",
    name: "numQuestions",
    message: "Enter the number of questions (-n):",
    default: 5,
    validate: (value) => {
      const valid = Number.isInteger(value) && value > 0;
      return valid || "Please enter a positive integer.";
    },
    filter: Number, // Ensure the result is a number
  },
  {
    type: "number",
    name: "depth",
    message: "Enter the depth (-d):",
    default: 2,
    validate: (value) => {
      const valid = Number.isInteger(value) && value >= 0;
      return valid || "Please enter a non-negative integer.";
    },
    filter: Number, // Ensure the result is a number
  },
];

// Function to run the main script with collected answers
function runMainScript(answers) {
  // Construct the command string carefully, quoting arguments
  // Ensure main.js path is correct relative to project root
  const command = `node ./main.js --url "${answers.url}" -k "${answers.apiKey}" -n ${answers.numQuestions} -d ${answers.depth}`;

  console.log("\n-----------------------------------------");
  console.log(`> Executing: ${command}`);
  console.log("-----------------------------------------\n");

  const child = exec(command);

  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  child.on("close", (code) => {
    console.log(`\n-----------------------------------------`);
    console.log(`main.js finished with exit code ${code}`);
    console.log("-----------------------------------------");
  });

  child.on("error", (error) => {
    console.error(`\n-----------------------------------------`);
    console.error(`Failed to start main.js: ${error.message}`);
    console.error("-----------------------------------------");
  });
}

// --- Main Execution using an async IIFE or top-level await ---
// Using an async IIFE for broader Node version compatibility
(async () => {
  console.log("Welcome! Please provide the parameters for main.js:");
  try {
    const answers = await inquirer.prompt(questions);
    // User provided all answers
    runMainScript(answers);
  } catch (error) {
    if (error.isTtyError) {
      console.error("Error: Prompt could not be rendered in this environment.");
    } else {
      console.error("An error occurred during the interactive prompt:", error);
    }
    process.exit(1); // Exit with an error code
  }
})();

// If you are using Node.js v14.8+ you could potentially use top-level await
// But the async IIFE ((async () => { ... })();) is safer across versions.
/*
// --- Alternative using Top-Level Await (Node v14.8+) ---
console.log('Welcome! Please provide the parameters for main.js:');
try {
    const answers = await inquirer.prompt(questions);
    runMainScript(answers);
} catch (error) {
     if (error.isTtyError) {
         console.error('Error: Prompt could not be rendered in this environment.');
     } else {
         console.error('An error occurred during the interactive prompt:', error);
     }
     process.exit(1);
}
*/
