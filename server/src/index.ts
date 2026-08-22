import * as db from './redis.js';
import { buildServer } from './server.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? '*';
const DRAIN_MS = 90_000;

const { app, rooms } = await buildServer(CORS_ORIGIN);

let draining = false;

async function shutdown(): Promise<void> {
  if (draining) return;
  draining = true;
  app.log.info('SIGTERM received, deregistering and draining');
  await rooms.broadcastServerRestarting();
  const drainTimer = setTimeout(() => {
    void (async () => {
      await db.closeRedis();
      await app.close();
      process.exit(0);
    })();
  }, DRAIN_MS);
  drainTimer.unref();
}

process.on('SIGTERM', () => void shutdown());

await app.listen({ port: PORT, host: HOST });
