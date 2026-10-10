// Backup + restore check (SECURITY §5: daily backup, restore tested every month).
//   npm run backup                      → backups/medshop-<db>-<time>.archive.gz[.enc] + .json manifest; keeps BACKUP_KEEP newest
//   npm run backup:verify [-- <file>]   → restores the newest (or given) backup into a scratch DB, compares counts, drops it
// Env: MONGODB_URI, BACKUP_DIR (./backups), BACKUP_KEEP (14), BACKUP_KEY (64 hex = AES-256-GCM; unset = plain),
//      MONGO_TOOLS_DIR (folder with mongodump / mongorestore when they are not on PATH).
/* eslint-disable security/detect-non-literal-fs-filename -- an operator tool: every path comes from BACKUP_DIR or the operator's own argument */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import mongoose from 'mongoose';

const MAGIC = Buffer.from('MSBK1');
const uri = process.env.MONGODB_URI ?? '';
const dir = resolve(process.env.BACKUP_DIR ?? 'backups');
const keep = Math.max(1, Number(process.env.BACKUP_KEEP ?? 14));
const keyHex = process.env.BACKUP_KEY ?? '';
const tool = (name: string) => (process.env.MONGO_TOOLS_DIR ? join(process.env.MONGO_TOOLS_DIR, name) : name);

interface Manifest {
  file: string;
  db: string;
  createdAt: string;
  encrypted: boolean;
  bytes: number;
  sha256: string;
  counts: Record<string, number>;
}

function key(): Buffer | null {
  if (!keyHex) return null;
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) throw new Error('BACKUP_KEY must be 64 hex characters (32 bytes)');
  return Buffer.from(keyHex, 'hex');
}

function dbName(u: string) {
  const name = new URL(u.replace(/^mongodb(\+srv)?:/, 'http:')).pathname.slice(1);
  if (!name) throw new Error('MONGODB_URI must name the database, like …/medicineshop');
  return name;
}

/** The server part of the URI — the tools get the database by flag, not in the URI. */
const serverUri = (u: string) => u.replace(/^(mongodb(?:\+srv)?:\/\/[^/?]+)\/[^?]*/, '$1/');

const readAt = (file: string, at: number, n: number) => {
  const fd = openSync(file, 'r');
  try {
    const b = Buffer.alloc(n);
    readSync(fd, b, 0, n, at);
    return b;
  } finally {
    closeSync(fd);
  }
};

function run(cmd: string, args: string[]) {
  return new Promise<void>((ok, fail) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-2000); });
    p.on('error', (e) => { fail(new Error(`${cmd}: ${e.message} — install MongoDB Database Tools or set MONGO_TOOLS_DIR`)); });
    p.on('close', (code) => { if (code === 0) ok(); else fail(new Error(`${cmd} exited ${String(code)}: ${err}`)); });
  });
}

async function counts(db: string) {
  const conn = mongoose.connection.useDb(db, { useCache: false });
  const out: Record<string, number> = {};
  for (const c of await conn.listCollections()) if (!c.name.startsWith('system.')) out[c.name] = await conn.collection(c.name).estimatedDocumentCount();
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

const sha256 = async (file: string) => {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
};

async function encrypt(plain: string, out: string, k: Buffer) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const w = createWriteStream(out);
  w.write(Buffer.concat([MAGIC, iv]));
  await pipeline(createReadStream(plain), c, w, { end: false });
  await new Promise<void>((ok, fail) => { w.end(c.getAuthTag(), () => { ok(); }); w.on('error', fail); });
}

async function decrypt(file: string, out: string, k: Buffer) {
  const size = statSync(file).size;
  const head = readAt(file, 0, MAGIC.length + 12);
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a MedBox24 encrypted backup');
  const tag = readAt(file, size - 16, 16);
  const d = createDecipheriv('aes-256-gcm', k, head.subarray(MAGIC.length), { authTagLength: 16 });
  d.setAuthTag(tag);
  await pipeline(createReadStream(file, { start: MAGIC.length + 12, end: size - 17 }), d, createWriteStream(out));
}

async function backup() {
  const db = dbName(uri);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = `medshop-${db}-${stamp}.archive.gz`;
  const plain = join(dir, base);
  await mongoose.connect(uri);
  const before = await counts(db);
  await run(tool('mongodump'), [`--uri=${serverUri(uri)}`, `--db=${db}`, `--archive=${plain}`, '--gzip', '--quiet']);
  const k = key();
  const file = k ? `${plain}.enc` : plain;
  if (k) {
    await encrypt(plain, file, k);
    rmSync(plain);
  }
  const m: Manifest = { file: file.split(/[\\/]/).pop() ?? file, db, createdAt: new Date().toISOString(), encrypted: Boolean(k), bytes: statSync(file).size, sha256: await sha256(file), counts: before };
  writeFileSync(`${file}.json`, JSON.stringify(m, null, 2));
  const all = readdirSync(dir).filter((f) => f.startsWith(`medshop-${db}-`) && !f.endsWith('.json')).sort().reverse();
  for (const old of all.slice(keep)) {
    rmSync(join(dir, old), { force: true });
    rmSync(join(dir, `${old}.json`), { force: true });
  }
  console.log(`✅ ${m.file} · ${(m.bytes / 1024 / 1024).toFixed(2)} MB · ${String(Object.keys(before).length)} collections · ${m.encrypted ? 'encrypted' : 'NOT encrypted (set BACKUP_KEY)'} · kept ${String(Math.min(all.length, keep))}`);
}

async function verify(given?: string) {
  const newest = readdirSync(dir).filter((f) => f.startsWith('medshop-') && !f.endsWith('.json')).sort().reverse()[0];
  const file = given ? resolve(given) : newest ? join(dir, newest) : '';
  if (!file || !existsSync(file) || !existsSync(`${file}.json`)) throw new Error('No backup with a manifest found');
  const m = JSON.parse(readFileSync(`${file}.json`, 'utf8')) as Manifest;
  if ((await sha256(file)) !== m.sha256) throw new Error('Checksum differs from the manifest — the file is damaged');
  let archive = file;
  if (m.encrypted) {
    const k = key();
    if (!k) throw new Error('This backup is encrypted — set BACKUP_KEY');
    archive = join(dir, `.verify-${String(Date.now())}.archive.gz`);
    try {
      await decrypt(file, archive, k);
    } catch {
      rmSync(archive, { force: true });
      throw new Error('Could not decrypt — wrong BACKUP_KEY, or the file was changed');
    }
  }
  const scratch = `medshop_restore_check_${String(Date.now())}`;
  await mongoose.connect(uri);
  try {
    await run(tool('mongorestore'), [`--uri=${serverUri(uri)}`, `--archive=${archive}`, '--gzip', `--nsFrom=${m.db}.*`, `--nsTo=${scratch}.*`, '--quiet']);
    const got = await counts(scratch);
    const bad = Object.entries(m.counts).filter(([c, n]) => (got[c] ?? -1) < Math.floor(n * 0.99));
    for (const [c, n] of Object.entries(m.counts)) console.log(`${bad.some(([b]) => b === c) ? '❌' : '  '} ${c.padEnd(28)} ${String(n).padStart(8)} → ${String(got[c] ?? 'missing').padStart(8)}`);
    if (bad.length) throw new Error(`${String(bad.length)} collection(s) came back short`);
    console.log(`✅ ${m.file} restores: ${String(Object.keys(got).length)} collections, ${String(Object.values(got).reduce((a, b) => a + b, 0))} documents (backup of ${m.createdAt})`);
  } finally {
    await mongoose.connection.useDb(scratch, { useCache: false }).dropDatabase();
    if (archive !== file) rmSync(archive, { force: true });
  }
}

const [cmd, arg] = process.argv.slice(2);
(cmd === 'verify' ? verify(arg) : backup())
  .then(async () => { await mongoose.disconnect(); })
  .catch(async (err: unknown) => {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    await mongoose.disconnect();
    process.exit(1);
  });
