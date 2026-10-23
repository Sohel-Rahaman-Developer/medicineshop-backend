// Reproduces the admin "first open takes minutes" on a local DB: a proxy that, like a NAT or firewall on the way to
// Atlas, silently drops a TCP connection left idle. Run: npx tsx scripts/probe-idle-db.ts
import net from 'node:net';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { DB_OPTIONS } from '../src/config/db';

const IDLE_MS = 3000;

/** Forwards bytes until a connection sits idle IDLE_MS; after that it swallows them, neither answering nor closing. */
function blackHoleProxy(target: number) {
  const server = net.createServer((client) => {
    const up = net.connect(target, '127.0.0.1');
    let last = Date.now();
    const alive = () => Date.now() - last < IDLE_MS;
    client.on('data', (b) => { if (alive()) { last = Date.now(); up.write(b); } });
    up.on('data', (b) => { if (alive()) { last = Date.now(); client.write(b); } });
    const end = () => { client.destroy(); up.destroy(); };
    client.on('error', end);
    up.on('error', end);
    client.on('close', end);
    up.on('close', end);
  });
  return new Promise<{ port: number; close: () => void }>((ok) => server.listen(0, '127.0.0.1', () => { ok({ port: (server.address() as net.AddressInfo).port, close: () => server.close() }); }));
}

async function trial(label: string, uri: string, opts: mongoose.ConnectOptions) {
  const m = new mongoose.Mongoose();
  // Heartbeats every second keep the monitor alive, as the 10 s default does against a NAT that waits minutes.
  await m.connect(uri, { ...opts, heartbeatFrequencyMS: 1000, serverSelectionTimeoutMS: 2000 });
  const col = m.connection.collection('probe');
  await col.insertOne({ n: 1 });
  const burst = () => Promise.all(Array.from({ length: 8 }, () => col.find({}).toArray()));
  await burst();
  await new Promise((r) => setTimeout(r, IDLE_MS + 2000));
  const t = Date.now();
  const res = await Promise.race([burst().then(() => 'answered'), new Promise<string>((r) => setTimeout(() => { r('STILL HANGING'); }, 20_000))]).catch((e: unknown) => `failed: ${String(e).slice(0, 80)}`);
  console.log(`${label.padEnd(58)} ${res} after ${String(Date.now() - t)} ms`);
  await m.disconnect().catch(() => undefined);
}

async function main() {
  const db = await MongoMemoryServer.create();
  const proxy = await blackHoleProxy(Number(new URL(db.getUri()).port));
  const uri = `mongodb://127.0.0.1:${String(proxy.port)}/probe?directConnection=true`;
  await trial('before (pool only, no idle or socket limit)', uri, { maxPoolSize: 20 });
  // DB_OPTIONS scaled down: the real ones are 30 s idle against a NAT that waits minutes.
  await trial('after: idle connections closed before the network drops them', uri, { ...DB_OPTIONS, maxIdleTimeMS: IDLE_MS - 1000, socketTimeoutMS: 5000 });
  await trial('after, if the network drops sooner: socket limit + retry', uri, { ...DB_OPTIONS, maxIdleTimeMS: 0, socketTimeoutMS: 5000 });
  proxy.close();
  await db.stop();
  process.exit(0);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
