/**
 * Server bootstrap — DB connect karo, phir hi listen karo.
 * Graceful shutdown: chal rahi requests poori hone do, phir band karo.
 */
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
    server.close(async () => {
      await disconnectDb();
      logger.info('Bye 👋');
      process.exit(0);
    });
    // Agar 10s me clean shutdown na ho to force kill.
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

main().catch((err) => {
  logger.fatal({ err }, 'Server start nahi ho paya');
  process.exit(1);
});
