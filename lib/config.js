/**
 * @fileoverview Configuration management system for YouTube Highlighter
 * @module config
 */
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import logger from './logger.js';

// Default configuration location
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.youtube-highlighter.json');

// Default configuration values
const DEFAULT_CONFIG = {
  apiKey: '',
  logLevel: 'info',
  outputFormat: {
    includeDetailedMetadata: true,
    generateThumbnails: false,
    thumbnailQuality: 'medium' // low, medium, high
  },
  performance: {
    retryCount: 3,
    maxConcurrentRequests: 3,
    parallelProcessing: true
  },
  highlights: {
    defaultCount: 5,
    defaultDuration: 2 // minutes
  },
  ui: {
    showProgressBar: true
  }
};

/**
 * Configuration manager class
 */
class ConfigManager {
  constructor(customConfigPath) {
    this.configPath = customConfigPath || DEFAULT_CONFIG_PATH;
    this.config = { ...DEFAULT_CONFIG };
    this.loaded = false;
  }

  /**
   * Load configuration from file
   * @returns {Object} Loaded configuration
   */
  load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const fileConfig = fs.readJsonSync(this.configPath);
        // Deep merge with defaults to ensure all fields exist
        this.config = this._deepMerge(DEFAULT_CONFIG, fileConfig);
        logger.debug(`Configuration loaded from ${this.configPath}`);
      } else {
        logger.debug(`No configuration file found at ${this.configPath}, using defaults`);
      }
      this.loaded = true;
    } catch (error) {
      logger.warn(`Failed to load configuration: ${error.message}`, error);
    }
    
    return this.config;
  }

  /**
   * Save current configuration to file
   * @returns {boolean} Success indicator
   */
  save() {
    try {
      fs.writeJsonSync(this.configPath, this.config, { spaces: 2 });
      logger.debug(`Configuration saved to ${this.configPath}`);
      return true;
    } catch (error) {
      logger.error(`Failed to save configuration: ${error.message}`, error);
      return false;
    }
  }

  /**
   * Deep merge two objects
   * @private
   * @param {Object} target - Target object
   * @param {Object} source - Source object to merge
   * @returns {Object} Merged object
   */
  _deepMerge(target, source) {
    const output = { ...target };
    
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      Object.keys(source).forEach(key => {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
          if (target[key]) {
            output[key] = this._deepMerge(target[key], source[key]);
          } else {
            output[key] = source[key];
          }
        } else {
          output[key] = source[key];
        }
      });
    }
    
    return output;
  }

  /**
   * Get a specific configuration value
   * @param {string} key - Configuration key (dot notation supported, e.g., 'outputFormat.generateThumbnails')
   * @param {*} defaultValue - Default value if not found
   * @returns {*} Configuration value
   */
  get(key, defaultValue) {
    if (!this.loaded) {
      this.load();
    }
    
    const keys = key.split('.');
    let value = this.config;
    
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        return defaultValue;
      }
    }
    
    return value;
  }

  /**
   * Set a specific configuration value
   * @param {string} key - Configuration key (dot notation supported)
   * @param {*} value - Value to set
   * @returns {boolean} Success indicator
   */
  set(key, value) {
    if (!this.loaded) {
      this.load();
    }
    
    const keys = key.split('.');
    let current = this.config;
    
    // Navigate to the nested property
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!(k in current) || typeof current[k] !== 'object') {
        current[k] = {};
      }
      current = current[k];
    }
    
    // Set the value
    current[keys[keys.length - 1]] = value;
    return true;
  }
}

// Create and export default instance
const configManager = new ConfigManager();

export default configManager;
export { ConfigManager }; 