import pino from 'pino';
import config from '../config/index.js'; // Use the config barrel file

// Map Pino levels to Google Cloud Logging severity levels for JSON logs
// https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#LogSeverity
const GcpSeverityLookup = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

// Determine if pretty printing should be used
const usePrettyPrint = config.app.nodeEnv === 'development' && config.app.prettyLog;

// --- Pino Logger Configuration ---

// Options common to both JSON and pretty print modes
const commonOptions = {
  level: config.app.logLevel || 'info',
  // Standard serializers for errors, etc.
  serializers: pino.stdSerializers,
};

// Specific options for JSON logging (production or when prettyLog is false)
const jsonOptions = {
  ...commonOptions,
  formatters: {
    level: (label) => {
      // Output severity for GCP compatibility
      return { severity: GcpSeverityLookup[label] || label.toUpperCase() };
    },
    // Ensure 'message' field is used instead of 'msg' for GCP
    log: (obj) => {
      if (typeof obj.msg === 'string') {
           obj.message = obj.msg;
           delete obj.msg;
      }
      return obj;
    }
  },
  // Use standard ISO timestamp format
  timestamp: pino.stdTimeFunctions.isoTime,
  messageKey: 'message', // Explicitly use 'message' key
  // Include process ID and hostname for context
  base: {
    pid: process.pid,
    // hostname: pino.stdTimeFunctions.hostname(), // Optional: can make logs verbose
    serviceContext: { service: 'chatsage' } // Useful for GCP Error Reporting/Logging grouping
  },
};

// Specific options/transport for pretty printing (development)
const prettyOptions = {
  ...commonOptions,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard', // Human-readable time
      ignore: 'pid,hostname,severity,serviceContext', // Hide fields less useful in local dev
      messageKey: 'message', // Tell pino-pretty to use 'message'
    },
  },
};

// Initialize the logger based on the environment/config
const logger = pino(usePrettyPrint ? prettyOptions : jsonOptions);

if (usePrettyPrint) {
    logger.info('Pretty logging enabled for development.');
} else {
    // Log the level being used in production for clarity
    logger.info({ configLogLevel: config.app.logLevel }, `Logger initialized (JSON format) at level: ${config.app.logLevel}`);
}

// Export the configured logger instance
export default logger;