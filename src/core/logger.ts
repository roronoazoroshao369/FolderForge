import pino from 'pino';

/**
 * Logger writes to stderr so it never corrupts the stdio MCP channel (stdout).
 */
export const logger = pino(
  {
    level: process.env.FOLDERFORGE_LOG_LEVEL ?? 'info',
    base: { service: 'folderforge' },
  },
  pino.destination(2)
);

export type Logger = typeof logger;
