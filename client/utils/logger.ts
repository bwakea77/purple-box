import { logger as createLogger } from 'react-native-logs';

/**
 * Logger configuration for the Purple Box app
 * - Development: Logs debug, info, warn, and error levels
 * - Production: Only logs error and warn levels
 */
const config = {
  // In production, keep only warn/error to reduce noise and avoid sensitive logging.
  severity: __DEV__ ? 'debug' : 'warn',
  transport: console,
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

export const logger = createLogger(config);

/**
 * Convenience methods for common log levels
 */
export const log = {
  debug: (message: string, ...args: any[]) => logger.debug(message, ...args),
  info: (message: string, ...args: any[]) => logger.info(message, ...args),
  warn: (message: string, ...args: any[]) => logger.warn(message, ...args),
  error: (message: string, error?: Error | unknown, ...args: any[]) => {
    if (error instanceof Error) {
      logger.error(message, error.message, error.stack, ...args);
    } else {
      logger.error(message, error, ...args);
    }
  },
};
