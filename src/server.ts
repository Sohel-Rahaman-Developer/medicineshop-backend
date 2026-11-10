import { createApp } from './app';
import { connectDb, disconnectDb } from './config/db';
import { env, isProd } from './config/env';
import { logger } from './config/logger';
import { startScheduler, stopScheduler } from './modules/notifications/jobs';
import { backfillFreeForLife } from './modules/webaddress/free-for-life';
import { bringOwnersForward } from './modules/roles/roles.service';

async function main() {
  await connectDb();
  await backfillFreeForLife().then((n) => { if (n) logger.info(`Free for life: ${String(n)} live web addresses took their places`); }, (err: unknown) => { logger.error({ err }, 'Free-for-life backfill failed'); });

  await bringOwnersForward().then((n) => { if (n) logger.info(`Payroll: ${String(n)} owner roles can now use it`); }, (err: unknown) => { logger.error({ err }, 'Owner roles update failed'); });

  const app = createApp();
  const ready = () => {
    logger.info(`🚀 API ready → http://localhost:${env.PORT}${env.API_PREFIX}  [${env.NODE_ENV}]`);
    startScheduler();
    // PM2 (wait_ready) moves traffic to this worker only now, so a reload never drops a request.
    process.send?.('ready');
    if (env.DEV_STATIC_OTP) logger.warn(`DEV_STATIC_OTP is on — every login code is ${env.DEV_STATIC_OTP} (development only)`);
  };
  // Straight to the port, a forged X-Forwarded-For would pass for the client's IP; behind Nginx it never does.
  const host = env.HOST ?? (isProd ? '127.0.0.1' : undefined);
  const server = host ? app.listen(env.PORT, host, ready) : app.listen(env.PORT, ready);

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down…');
    void stopScheduler();
    // Requests in flight finish; idle keep-alive connections close now instead of holding the exit.
    server.close(() => {
      void disconnectDb().finally(() => {
        logger.info('Bye 👋');
        process.exit(0);
      });
    });
    server.closeIdleConnections();
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
