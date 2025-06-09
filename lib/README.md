# Logger Module

A comprehensive logging system for debugging and error tracking in JavaScript applications.

## Features

- Class-based modular architecture
- Multiple log levels (DEBUG, INFO, WARN, ERROR, NONE)
- Standardized error formatting and error codes
- Customizable timestamp inclusion
- Detailed formatting for various data types
- Helper methods for standardized error creation

## Usage

### Basic Usage

```javascript
import logger from '../lib/logger.js';

// Log messages with different severity
logger.debug('Debug message');
logger.info('Info message');
logger.warn('Warning message', { details: 'Additional information' });
logger.error('Error occurred', new Error('Something went wrong'));

// Change log level
logger.setLogLevel('DEBUG');
```

### Custom Logger Instances

```javascript
import { Logger } from '../lib/logger.js';

// Create a custom logger with options
const customLogger = new Logger({
  level: 'DEBUG',              // Initial log level
  includeTimestamp: false      // Disable timestamps in logs
});

customLogger.info('Application started');
```

### Standardized Error Handling

```javascript
import logger, { ERROR_CODES } from '../lib/logger.js';

try {
  // Some operation that might fail
  throw new Error('Authentication failed');
} catch (error) {
  // Create a standardized error with code and details
  const standardError = logger.createError(
    'Failed to authenticate user',
    ERROR_CODES.AUTH,
    { 
      userId: '123',
      attemptCount: 3
    }
  );
  
  // Error is already logged by createError
  // Handle or throw the standardized error
  throw standardError;
}
```

## Available Log Levels

- `DEBUG`: Detailed information for debugging
- `INFO`: General information about application progress
- `WARN`: Warning situations that might cause issues
- `ERROR`: Error events that might still allow the application to continue
- `NONE`: Disable all logging

## Error Codes

- `E_NETWORK`: Network-related errors
- `E_VALIDATION`: Input validation errors
- `E_AUTH`: Authentication errors
- `E_PERMISSION`: Permission/authorization errors
- `E_NOT_FOUND`: Resource not found errors
- `E_SERVER`: Server errors
- `E_UNKNOWN`: Unknown/unclassified errors

## Configuration

The logger's behavior can be configured via environment variables or through constructor options:

```javascript
// Via environment variable
process.env.LOG_LEVEL = 'DEBUG';

// Or via constructor options
const logger = new Logger({ 
  level: 'DEBUG',
  includeTimestamp: true
});
```

## Testing

The Logger module has comprehensive unit tests. Run them with:

```bash
npm test
``` 