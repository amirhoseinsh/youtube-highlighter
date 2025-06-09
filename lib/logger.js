/**
 * @fileoverview Detailed logging system for debugging and error tracking
 * @module Logger
 */

/**
 * @enum {number}
 * @readonly
 * @description Log levels for controlling logging verbosity
 */
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 4
};

/**
 * @enum {string}
 * @readonly
 * @description Standard error codes for consistent error handling
 */
const ERROR_CODES = {
  NETWORK: 'E_NETWORK',
  VALIDATION: 'E_VALIDATION',
  AUTH: 'E_AUTH',
  PERMISSION: 'E_PERMISSION',
  NOT_FOUND: 'E_NOT_FOUND',
  SERVER: 'E_SERVER',
  UNKNOWN: 'E_UNKNOWN'
};

/**
 * Logger class providing structured logging capabilities
 * @class
 */
class Logger {
  /**
   * Creates a new Logger instance
   * @param {Object} [options] - Logger configuration options
   * @param {string} [options.level] - Initial log level
   * @param {boolean} [options.includeTimestamp=true] - Whether to include timestamps in logs
   */
  constructor(options = {}) {
    // Default to INFO level, can be overridden via environment variable or options
    this.logLevel = options.level ? 
      LOG_LEVELS[options.level.toUpperCase()] : 
      process.env.LOG_LEVEL ? 
        LOG_LEVELS[process.env.LOG_LEVEL.toUpperCase()] || LOG_LEVELS.INFO : 
        LOG_LEVELS.INFO;
    
    this.includeTimestamp = options.includeTimestamp !== undefined ? 
      options.includeTimestamp : true;
  }

  /**
   * Generates a timestamp string in ISO format
   * @private
   * @returns {string} ISO formatted timestamp
   */
  _timestamp() {
    return new Date().toISOString();
  }

  /**
   * Format log message with timestamp, level, and optional data
   * @private
   * @param {string} level - Log level indicator
   * @param {string} message - Main log message
   * @param {*} [data] - Additional data to include in log
   * @returns {string} Formatted log message
   */
  _formatLog(level, message, data) {
    let logString = '';
    
    // Add timestamp if enabled
    if (this.includeTimestamp) {
      const ts = this._timestamp();
      logString += `[${ts}] `;
    }
    
    // Add log level
    logString += `[${level}] ${message}`;
    
    // Format additional data
    if (data) {
      if (data instanceof Error) {
        logString += this._formatError(data);
      } else if (typeof data === 'object') {
        try {
          logString += `\n  Data: ${JSON.stringify(data, null, 2)}`;
        } catch (e) {
          logString += `\n  Data: [Object - Unable to stringify]`;
        }
      } else {
        logString += `\n  ${data}`;
      }
    }
    
    return logString;
  }
  
  /**
   * Standardize error formatting for consistency
   * @private
   * @param {Error} error - Error object to format
   * @returns {string} Formatted error string
   */
  _formatError(error) {
    let result = `\n  Error: ${error.message}`;
    
    // Add error code if available
    if (error.code) {
      result += `\n  Code: ${error.code}`;
    }
    
    // Add stack trace if available
    if (error.stack) {
      result += `\n  Stack: ${error.stack}`;
    }
    
    // Add HTTP status if available
    if (error.status || error.statusCode) {
      result += `\n  Status: ${error.status || error.statusCode}`;
    }
    
    // Add response data if available (for axios/fetch errors)
    if (error.response) {
      try {
        const responseData = error.response.data || error.response;
        result += `\n  Response: ${JSON.stringify(responseData, null, 2)}`;
      } catch (e) {
        result += `\n  Response: [Unable to stringify response]`;
      }
    }
    
    return result;
  }

  /**
   * Sets the logging level
   * @param {string} level - Log level to set ('DEBUG', 'INFO', 'WARN', 'ERROR', 'NONE')
   * @returns {boolean} Success indicator
   */
  setLogLevel(level) {
    if (LOG_LEVELS[level] !== undefined) {
      this.logLevel = LOG_LEVELS[level];
      this.info(`Log level set to ${level}`);
      return true;
    } else {
      const currentLevel = Object.keys(LOG_LEVELS).find(key => LOG_LEVELS[key] === this.logLevel);
      this.warn(`Invalid log level: ${level}. Using current level: ${currentLevel}`);
      return false;
    }
  }
  
  /**
   * Logs a DEBUG level message
   * @param {string} message - Message to log
   * @param {*} [data] - Additional data to include
   */
  debug(message, data) {
    if (this.logLevel <= LOG_LEVELS.DEBUG) {
      console.log(this._formatLog('DEBUG', message, data));
    }
  }
  
  /**
   * Logs an INFO level message
   * @param {string} message - Message to log
   * @param {*} [data] - Additional data to include
   */
  info(message, data) {
    if (this.logLevel <= LOG_LEVELS.INFO) {
      console.log(this._formatLog('INFO', message, data));
    }
  }
  
  /**
   * Logs a WARN level message
   * @param {string} message - Message to log
   * @param {*} [data] - Additional data to include
   */
  warn(message, data) {
    if (this.logLevel <= LOG_LEVELS.WARN) {
      console.warn(this._formatLog('WARN', message, data));
    }
  }
  
  /**
   * Logs an ERROR level message
   * @param {string} message - Message to log
   * @param {*} [data] - Additional data to include
   */
  error(message, data) {
    if (this.logLevel <= LOG_LEVELS.ERROR) {
      console.error(this._formatLog('ERROR', message, data));
    }
  }
  
  /**
   * Creates a standardized error with code and logs it
   * @param {string} message - Error message
   * @param {string} code - Error code from ERROR_CODES
   * @param {Object} [details] - Additional error details
   * @returns {Error} The created error object
   */
  createError(message, code = ERROR_CODES.UNKNOWN, details = {}) {
    const error = new Error(message);
    error.code = ERROR_CODES[code] || code;
    
    // Add additional details to the error
    Object.keys(details).forEach(key => {
      error[key] = details[key];
    });
    
    // Log the error
    this.error(message, error);
    
    return error;
  }
}

// Create default instance
const logger = new Logger();

/**
 * @typedef {Object} LoggerExports
 * @property {Logger} Logger - Logger class for creating custom instances
 * @property {Object} LOG_LEVELS - Available log levels
 * @property {Object} ERROR_CODES - Standardized error codes
 */

// Export both the default instance and the class for flexibility
export default logger;
export { Logger, LOG_LEVELS, ERROR_CODES }; 