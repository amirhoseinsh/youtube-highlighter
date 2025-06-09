// lib/api-client.js - Groq API client with robust error handling and retries
import { Groq } from "groq-sdk";
import { setTimeout } from "timers/promises";
import logger from "./logger.js";

// Default retry configuration
const DEFAULT_RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 1000, // 1 second initial delay
  maxDelayMs: 30000, // Maximum 30 second delay
  factor: 2, // Exponential backoff factor
  jitter: 0.1, // Add randomness to avoid thundering herd
};

// Categorize errors into retryable and non-retryable
const isRetryableError = (error) => {
  // Network errors, timeouts, and rate limits are typically retryable
  if (!error.response) {
    logger.debug("Network error detected - retryable", error);
    return true; // Network error with no response
  }
  
  const status = error.response?.status;
  
  // 429 Too Many Requests, 503 Service Unavailable, 502 Bad Gateway, 504 Gateway Timeout
  if ([429, 502, 503, 504].includes(status)) {
    logger.debug(`Retryable status code: ${status}`, error);
    return true;
  }
  
  // Check for specific Groq error codes that might be retryable
  const errorCode = error.response?.data?.error?.code;
  const retryableCodes = ['rate_limit_exceeded', 'server_error', 'service_unavailable', 'timeout'];
  
  if (retryableCodes.includes(errorCode)) {
    logger.debug(`Retryable error code: ${errorCode}`, error);
    return true;
  }
  
  return false;
};

// Function to create Groq client with retries
export function createGroqClient(apiKey, customRetryConfig = {}) {
  if (!apiKey) {
    throw new Error("Groq API key is required");
  }
  
  const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...customRetryConfig };
  const groq = new Groq({ apiKey });
  
  // Wrap the original chat.completions.create with retry logic
  const originalCreate = groq.chat.completions.create;
  
  groq.chat.completions.create = async function(params) {
    let retries = 0;
    let delay = retryConfig.initialDelayMs;
    
    while (true) {
      try {
        logger.debug("Making Groq API call", { 
          model: params.model,
          retryAttempt: retries > 0 ? retries : "initial call" 
        });
        
        const result = await originalCreate.call(this, params);
        
        // Log successful response
        logger.debug("Groq API call successful", { 
          model: params.model,
          tokens: result.usage?.total_tokens,
          responseLength: result.choices?.[0]?.message?.content?.length || 0
        });
        
        return result;
      } catch (error) {
        // Log the error with different levels based on retry status
        if (retries === 0) {
          logger.warn(`Groq API error on initial attempt`, error);
        } else {
          logger.warn(`Groq API error on retry ${retries}/${retryConfig.maxRetries}`, error);
        }
        
        // Check if we should retry
        if (retries >= retryConfig.maxRetries || !isRetryableError(error)) {
          logger.error("Groq API call failed after retries", error);
          throw error; // Re-throw if max retries reached or non-retryable
        }
        
        // Calculate backoff with jitter
        const jitterAmount = delay * retryConfig.jitter;
        const jitteredDelay = delay + (Math.random() * 2 - 1) * jitterAmount;
        const actualDelay = Math.min(jitteredDelay, retryConfig.maxDelayMs);
        
        logger.info(`Retrying in ${Math.round(actualDelay / 1000)} seconds...`);
        await setTimeout(actualDelay);
        
        // Increase retry count and delay for next attempt
        retries++;
        delay = Math.min(delay * retryConfig.factor, retryConfig.maxDelayMs);
      }
    }
  };
  
  return groq;
}

// Utility function to handle token rate limiting
export async function throttleApiCalls(tokensNeeded, tpmLimit, rpmLimit, currentState) {
  const now = Date.now();
  const msSinceLastCall = now - currentState.lastCallTimestamp;
  
  // Refill the token and request buckets based on time elapsed
  currentState.tokensAvailable = Math.min(
    tpmLimit, 
    currentState.tokensAvailable + (tpmLimit * msSinceLastCall) / 60000
  );
  
  currentState.requestsAvailable = Math.min(
    rpmLimit,
    currentState.requestsAvailable + (rpmLimit * msSinceLastCall) / 60000
  );
  
  // Update timestamp
  currentState.lastCallTimestamp = now;
  
  // Calculate if we need to wait
  const tokensNeeded_wait = tokensNeeded > currentState.tokensAvailable 
    ? ((tokensNeeded - currentState.tokensAvailable) * 60000) / tpmLimit 
    : 0;
    
  const requests_wait = currentState.requestsAvailable < 1
    ? ((1 - currentState.requestsAvailable) * 60000) / rpmLimit
    : 0;
  
  const waitTime = Math.max(tokensNeeded_wait, requests_wait);
  
  if (waitTime > 0) {
    logger.info(`Rate limit throttling for ${Math.ceil(waitTime / 1000)}s`, {
      tokensNeeded,
      tokensAvailable: currentState.tokensAvailable,
      requestsAvailable: currentState.requestsAvailable
    });
    
    await setTimeout(waitTime);
    
    // Recursive call after waiting
    return throttleApiCalls(tokensNeeded, tpmLimit, rpmLimit, currentState);
  }
  
  // Deduct from buckets
  currentState.tokensAvailable -= tokensNeeded;
  currentState.requestsAvailable -= 1;
  
  logger.debug("Rate limit check passed", {
    tokensRemaining: currentState.tokensAvailable,
    requestsRemaining: currentState.requestsAvailable
  });
  
  return currentState;
} 