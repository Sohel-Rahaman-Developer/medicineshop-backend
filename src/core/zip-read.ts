import { inflateRawSync } from 'node:zlib';

const MAX_FILES = 400;
const MAX_TOTAL = 30 * 1024 * 1024;

/** The files of a zip (DOCX is one), by name. Stored and deflated entries only; a zip bomb stops at 30 MB. */
export function readZip(buf: Buffer, want?: (name: string) => boolean): Map<string, Buffer> {
  // End of central directory: the last "PK\x05\x06" within the final 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  if (count > MAX_FILES) throw new Error('Too many files inside');
  let at = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('Broken zip');
    const method = buf.readUInt16LE(at + 10);
    const packed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (want && !want(name)) continue;
    total += size;
    if (total > MAX_TOTAL) throw new Error('The file is too large inside');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + packed);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data, { maxOutputLength: Math.max(size, 1) }));
    else throw new Error('Unsupported zip compression');
  }
  return out;
}
