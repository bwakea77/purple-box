import { logger, consoleTransport } from 'react-native-logs';

/**
 * Logger configuration for the Purple Box app
 * - Development: Logs debug, info, warn, and error levels
 * - Production: Only logs error and warn levels
 */
const config = {
  // In production, keep only warn/error to reduce noise and avoid sensitive logging.
  severity: __DEV__ ? 'debug' : 'warn',
  transport: consoleTransport,
  transportOptions: {
    colors: {
      info: 'blueBright',
      warn: 'yellowBright',
      error: 'redBright',
      debug: 'greenBright',
    },
  },
  async: false,
  dateFormat: 'time',
  printLevel: __DEV__,
  printDate: __DEV__,
  enabled: true,
};

export const loggerInstance = logger.createLogger(config);

/**
 * Convenience methods for common log levels
 */
export const log = {
  debug: (message: string, ...args: any[]) => loggerInstance.debug(message, ...args),
  info: (message: string, ...args: any[]) => loggerInstance.info(message, ...args),
  warn: (message: string, ...args: any[]) => loggerInstance.warn(message, ...args),
  error: (message: string, error?: Error | unknown, ...args: any[]) => {
    if (error instanceof Error) {
      loggerInstance.error(message, error.message, error.stack, ...args);
    } else {
      loggerInstance.error(message, error, ...args);
    }
  },
};
