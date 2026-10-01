import { createApp } from './app';
import { connectDb, disconnectDb } from './config/db';
import { env } from './config/env';
import { logger } from './config/logger';

async function main() {
  await connectDb();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`🚀 API ready → http://localhost:${env.PORT}${env.API_PREFIX}  [${env.NODE_ENV}]`);
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down…');
    server.close(() => {
      void disconnectDb().finally(() => {
        logger.info('Bye 👋');
        process.exit(0);
      });
    });
    // Force the exit if a clean shutdown has not happened within 10 seconds.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Unhandled promise rejection');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Server failed to start');
  process.exit(1);
});
