/** Process entry point: configuration, start-up and graceful shutdown. */
import { existsSync } from 'node:fs';
import { ConfigError, loadConfig } from './config.ts';
import { Logger } from './logger.ts';
import { createApp } from './app.ts';

const envFile = process.env.ENV_FILE ?? '.env';
if (existsSync(envFile)) {
  // Variables already present in the environment take precedence over the file.
  process.loadEnvFile(envFile);
}

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const logger = new Logger({ level: config.logging.level, bindings: { service: 'adlinkfly-resolver' } });
const app = await createApp(config, { logger });

let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  logger.info('signal received', { signal });
  const force = setTimeout(() => {
    logger.error('forced exit after shutdown timeout');
    process.exit(1);
  }, config.server.shutdownGraceMs + 20_000);
  force.unref();
  app.close().then(
    () => process.exit(0),
    (err: unknown) => {
      logger.error('error during shutdown', { error: (err as Error).message });
      process.exit(1);
    },
  );
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled promise rejection', { error: reason instanceof Error ? reason.message : String(reason) });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception, exiting', { error: err.message, stack: err.stack });
  process.exit(1);
});

try {
  await app.listen();
} catch (err) {
  logger.error('failed to start', { error: (err as Error).message });
  await app.close().catch(() => undefined);
  process.exit(1);
}
