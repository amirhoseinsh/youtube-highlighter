/**
 * @fileoverview Unit tests for the Logger module
 */
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import logger, { Logger, LOG_LEVELS, ERROR_CODES } from '../lib/logger.js';

// Mock for video processing options tests
vi.mock('../lib/video-utils.js', () => ({
  downloadHighlights: vi.fn().mockResolvedValue(['path/to/video1.mp4']),
  getVideoInfo: vi.fn().mockResolvedValue({ id: 'test123', title: 'Test Video', duration: 600 }),
  generateThumbnail: vi.fn().mockResolvedValue('path/to/thumbnail.jpg')
}));

// Import processor after mocking dependencies
import { processVideo } from '../lib/processor.js';
import { downloadHighlights, getVideoInfo } from '../lib/video-utils.js';

describe('Logger', () => {
  let consoleSpy = {
    log: null,
    warn: null,
    error: null
  };
  
  // Setup console spies before each test
  beforeEach(() => {
    consoleSpy.log = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleSpy.warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleSpy.error = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    // Reset mocks
    vi.mocked(downloadHighlights).mockClear();
  });
  
  // Restore console methods after each test
  afterEach(() => {
    consoleSpy.log.mockRestore();
    consoleSpy.warn.mockRestore();
    consoleSpy.error.mockRestore();
  });
  
  describe('Logger class', () => {
    it('should create a new logger instance with default settings', () => {
      const customLogger = new Logger();
      expect(customLogger).toBeInstanceOf(Logger);
      expect(customLogger.logLevel).toBe(LOG_LEVELS.INFO);
      expect(customLogger.includeTimestamp).toBe(true);
    });
    
    it('should accept custom log level through constructor', () => {
      const customLogger = new Logger({ level: 'DEBUG' });
      expect(customLogger.logLevel).toBe(LOG_LEVELS.DEBUG);
    });
    
    it('should accept timestamp configuration', () => {
      const customLogger = new Logger({ includeTimestamp: false });
      expect(customLogger.includeTimestamp).toBe(false);
    });
    
    it('should format timestamps correctly', () => {
      const customLogger = new Logger();
      const timestamp = customLogger._timestamp();
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
    });
  });
  
  describe('Log level management', () => {
    it('should change log level when valid level provided', () => {
      const customLogger = new Logger({ level: 'INFO' });
      const result = customLogger.setLogLevel('DEBUG');
      expect(result).toBe(true);
      expect(customLogger.logLevel).toBe(LOG_LEVELS.DEBUG);
    });
    
    it('should reject invalid log levels', () => {
      const customLogger = new Logger({ level: 'INFO' });
      const result = customLogger.setLogLevel('INVALID');
      expect(result).toBe(false);
      expect(customLogger.logLevel).toBe(LOG_LEVELS.INFO);
    });
  });
  
  describe('Logging methods', () => {
    it('should log debug messages when level is DEBUG', () => {
      const customLogger = new Logger({ level: 'DEBUG' });
      customLogger.debug('Test debug message');
      expect(consoleSpy.log).toHaveBeenCalled();
      expect(consoleSpy.log.mock.calls[0][0]).toContain('[DEBUG] Test debug message');
    });
    
    it('should not log debug messages when level is INFO', () => {
      const customLogger = new Logger({ level: 'INFO' });
      customLogger.debug('Test debug message');
      expect(consoleSpy.log).not.toHaveBeenCalled();
    });
    
    it('should log info messages when level is INFO', () => {
      const customLogger = new Logger({ level: 'INFO' });
      customLogger.info('Test info message');
      expect(consoleSpy.log).toHaveBeenCalled();
      expect(consoleSpy.log.mock.calls[0][0]).toContain('[INFO] Test info message');
    });
    
    it('should log warning messages when level is WARN', () => {
      const customLogger = new Logger({ level: 'WARN' });
      customLogger.warn('Test warning message');
      expect(consoleSpy.warn).toHaveBeenCalled();
      expect(consoleSpy.warn.mock.calls[0][0]).toContain('[WARN] Test warning message');
    });
    
    it('should log error messages when level is ERROR', () => {
      const customLogger = new Logger({ level: 'ERROR' });
      customLogger.error('Test error message');
      expect(consoleSpy.error).toHaveBeenCalled();
      expect(consoleSpy.error.mock.calls[0][0]).toContain('[ERROR] Test error message');
    });
    
    it('should not log any messages when level is NONE', () => {
      const customLogger = new Logger({ level: 'NONE' });
      customLogger.debug('Test debug');
      customLogger.info('Test info');
      customLogger.warn('Test warn');
      customLogger.error('Test error');
      
      expect(consoleSpy.log).not.toHaveBeenCalled();
      expect(consoleSpy.warn).not.toHaveBeenCalled();
      expect(consoleSpy.error).not.toHaveBeenCalled();
    });
    
    it('should respect the includeTimestamp option', () => {
      const customLogger = new Logger({ level: 'INFO', includeTimestamp: false });
      customLogger.info('Test without timestamp');
      
      expect(consoleSpy.log).toHaveBeenCalled();
      const logMessage = consoleSpy.log.mock.calls[0][0];
      
      // Should not have the timestamp format
      expect(logMessage).not.toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z\]/);
      // Should just start with log level
      expect(logMessage).toMatch(/^\[INFO\]/);
    });
  });
  
  describe('Data formatting', () => {
    it('should format basic Error objects correctly', () => {
      const customLogger = new Logger({ level: 'INFO' });
      const testError = new Error('Test error message');
      testError.stack = 'Error: Test error message\n    at Test.it';
      
      customLogger.error('An error occurred', testError);
      expect(consoleSpy.error).toHaveBeenCalled();
      const logMessage = consoleSpy.error.mock.calls[0][0];
      
      expect(logMessage).toContain('[ERROR] An error occurred');
      expect(logMessage).toContain('Error: Test error message');
      expect(logMessage).toContain('Stack: Error: Test error message');
    });
    
    it('should format errors with codes correctly', () => {
      const customLogger = new Logger({ level: 'INFO' });
      const testError = new Error('Resource not found');
      testError.code = ERROR_CODES.NOT_FOUND;
      
      customLogger.error('Request failed', testError);
      expect(consoleSpy.error).toHaveBeenCalled();
      const logMessage = consoleSpy.error.mock.calls[0][0];
      
      expect(logMessage).toContain('[ERROR] Request failed');
      expect(logMessage).toContain('Error: Resource not found');
      expect(logMessage).toContain(`Code: ${ERROR_CODES.NOT_FOUND}`);
    });
    
    it('should format HTTP errors with status correctly', () => {
      const customLogger = new Logger({ level: 'INFO' });
      const httpError = new Error('HTTP Error');
      httpError.status = 404;
      httpError.response = { message: 'Not Found' };
      
      customLogger.error('API request failed', httpError);
      expect(consoleSpy.error).toHaveBeenCalled();
      const logMessage = consoleSpy.error.mock.calls[0][0];
      
      expect(logMessage).toContain('[ERROR] API request failed');
      expect(logMessage).toContain('Error: HTTP Error');
      expect(logMessage).toContain('Status: 404');
      expect(logMessage).toContain('"message": "Not Found"');
    });
    
    it('should format objects correctly', () => {
      const customLogger = new Logger({ level: 'INFO' });
      const testObject = { key: 'value', nested: { deeper: true } };
      
      customLogger.info('Test object', testObject);
      expect(consoleSpy.log).toHaveBeenCalled();
      const logMessage = consoleSpy.log.mock.calls[0][0];
      
      expect(logMessage).toContain('[INFO] Test object');
      expect(logMessage).toContain('"key": "value"');
      expect(logMessage).toContain('"nested": {');
      expect(logMessage).toContain('"deeper": true');
    });
    
    it('should handle unstringifiable objects gracefully', () => {
      const customLogger = new Logger({ level: 'INFO' });
      // Create circular reference
      const circular = {};
      circular.self = circular;
      
      customLogger.info('Circular object', circular);
      expect(consoleSpy.log).toHaveBeenCalled();
      const logMessage = consoleSpy.log.mock.calls[0][0];
      
      expect(logMessage).toContain('[INFO] Circular object');
      expect(logMessage).toContain('[Object - Unable to stringify]');
    });
  });
  
  describe('Error creation', () => {
    it('should create standardized errors', () => {
      const customLogger = new Logger({ level: 'ERROR' });
      const error = customLogger.createError(
        'Failed to authenticate user', 
        'AUTH',
        { userId: '123', attemptCount: 3 }
      );
      
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('Failed to authenticate user');
      expect(error.code).toBe(ERROR_CODES.AUTH);
      expect(error.userId).toBe('123');
      expect(error.attemptCount).toBe(3);
      
      // Should have logged the error
      expect(consoleSpy.error).toHaveBeenCalled();
      const logMessage = consoleSpy.error.mock.calls[0][0];
      expect(logMessage).toContain('[ERROR] Failed to authenticate user');
    });
    
    it('should use UNKNOWN code as default', () => {
      const customLogger = new Logger({ level: 'ERROR' });
      const error = customLogger.createError('Something went wrong');
      
      expect(error.code).toBe(ERROR_CODES.UNKNOWN);
    });
    
    it('should accept custom error codes', () => {
      const customLogger = new Logger({ level: 'ERROR' });
      const error = customLogger.createError('Custom error', 'CUSTOM_CODE');
      
      expect(error.code).toBe('CUSTOM_CODE');
    });
  });
  
  describe('Default export', () => {
    it('should export a pre-configured logger instance', () => {
      expect(logger).toBeInstanceOf(Logger);
      
      // Test the default logger works
      logger.info('Test default logger');
      expect(consoleSpy.log).toHaveBeenCalled();
    });
    
    it('should export LOG_LEVELS and ERROR_CODES', () => {
      expect(LOG_LEVELS).toBeDefined();
      expect(LOG_LEVELS.DEBUG).toBe(0);
      
      expect(ERROR_CODES).toBeDefined();
      expect(ERROR_CODES.NOT_FOUND).toBe('E_NOT_FOUND');
    });
  });
  
  // New Video Processing Options Tests
  describe('Video Processing Options', () => {
    // Setup for video processing tests
    beforeEach(() => {
      vi.mocked(downloadHighlights).mockClear();
      vi.mocked(getVideoInfo).mockClear();
    });
    
    it('should pass video quality settings to downloadHighlights', async () => {
      // Create minimal test environment for processVideo
      const mockFS = {
        ensureDir: vi.fn().mockResolvedValue(),
        pathExists: vi.fn().mockResolvedValue(true),
        readFile: vi.fn().mockResolvedValue('1\n00:00:00,000 --> 00:00:05,000\nTest subtitle'),
        writeFile: vi.fn().mockResolvedValue(),
        writeJson: vi.fn().mockResolvedValue()
      };
      
      vi.doMock('fs-extra', () => mockFS);
      
      // Mock other dependencies
      vi.mock('../lib/srt-utils.js', () => ({
        downloadSubtitles: vi.fn().mockResolvedValue({
          subtitles: [{start: 0, end: 5000, text: 'Test subtitle'}],
          savedSrtPath: 'path/to/subtitles.srt',
          videoSpecificOutputDir: 'path/to/output'
        }),
        parseSrt: vi.fn().mockReturnValue([{start: 0, end: 5000, text: 'Test subtitle'}]),
        formatSrtTimestamp: vi.fn().mockReturnValue('00:00:00,000'),
        parseTimestampHMS: vi.fn().mockReturnValue(5000)
      }));
      
      vi.mock('../lib/repunctuate.js', () => ({
        repunctuate: vi.fn().mockReturnValue([{start: 0, end: 5000, text: 'Test subtitle'}])
      }));
      
      vi.mock('../lib/question-classifier.js', () => ({
        classifySentences: vi.fn().mockResolvedValue([{start: 0, end: 5000, text: 'Test subtitle', type: 'Q'}])
      }));
      
      vi.mock('../lib/build-blocks.js', () => ({
        buildBlocks: vi.fn().mockReturnValue([{startTime: '00:00:00', endTime: '00:00:05', text: 'Test block'}])
      }));
      
      vi.mock('../lib/groq-scorer.js', () => ({
        scoreSegments: vi.fn().mockResolvedValue([{startTime: '00:00:00', endTime: '00:00:05', score: 0.9, text: 'Test block'}])
      }));
      
      // Test with custom quality, format and smart trimming options
      await processVideo({
        url: 'https://youtube.com/watch?v=test123',
        prompt: 'test',
        apiKey: 'test-api-key',
        numHighlights: 1,
        minSeconds: 5,
        outputBasePath: 'path/to/output',
        videoOptions: {
          quality: 'high',
          format: 'webm',
          smartTrimming: false
        }
      });
      
      // Verify downloadHighlights was called with correct options
      expect(downloadHighlights).toHaveBeenCalledTimes(1);
      expect(downloadHighlights.mock.calls[0][6]).toEqual({
        quality: 'high',
        format: 'webm',
        smartTrimming: false
      });
      
      // Reset mocks
      vi.resetModules();
    });
  });
}); 