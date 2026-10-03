import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { crc32 } from 'node:zlib';

export const ZIP_MAX_FILES = 65_000;
export const ZIP_MAX_BYTES = 3.5 * 1024 ** 3;
const IST = 5.5 * 60 * 60 * 1000;

interface Entry {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

const dos = (at: Date) => {
  const d = new Date(Math.max(at.getTime(), Date.UTC(1980, 0, 1)) + IST);
  return { time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1), date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate() };
};

/** Store-only ZIP written as it goes (photos are WebP already), UTF-8 names; callers keep it under ZIP_MAX_*. */
export class ZipWriter {
  private offset = 0;
  private readonly entries: Entry[] = [];

  constructor(private readonly out: Writable) {}

  private async write(b: Buffer) {
    if (this.out.destroyed) throw new Error('ZIP reader went away');
    this.offset += b.length;
    if (this.out.write(b)) return;
    const ac = new AbortController();
    const wait = (ev: string) => once(this.out, ev, { signal: ac.signal }).catch(() => undefined);
    await Promise.race([wait('drain'), wait('close')]);
    ac.abort();
  }

  async add(path: string, data: Buffer, at = new Date()) {
    const name = Buffer.from(path, 'utf8');
    const e: Entry = { name, crc: crc32(data), size: data.length, offset: this.offset, ...dos(at) };
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0800, 6);
    h.writeUInt16LE(0, 8);
    h.writeUInt16LE(e.time, 10);
    h.writeUInt16LE(e.date, 12);
    h.writeUInt32LE(e.crc, 14);
    h.writeUInt32LE(e.size, 18);
    h.writeUInt32LE(e.size, 22);
    h.writeUInt16LE(name.length, 26);
    h.writeUInt16LE(0, 28);
    this.entries.push(e);
    await this.write(Buffer.concat([h, name]));
    await this.write(data);
  }

  async end() {
    const start = this.offset;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(0, 10);
      c.writeUInt16LE(e.time, 12);
      c.writeUInt16LE(e.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.size, 20);
      c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.name.length, 28);
      c.writeUInt32LE(e.offset, 42);
      await this.write(Buffer.concat([c, e.name]));
    }
    const z = Buffer.alloc(22);
    z.writeUInt32LE(0x06054b50, 0);
    z.writeUInt16LE(this.entries.length, 8);
    z.writeUInt16LE(this.entries.length, 10);
    z.writeUInt32LE(this.offset - start, 12);
    z.writeUInt32LE(start, 16);
    await this.write(z);
    this.out.end();
  }
}
