// Minimal ZIP reader for uploaded archives (the TV Time data export). Dependency
// free: it walks the central directory and inflates entries with Node's zlib.
// Only the entries whose file name (without folders) is in `wanted` are read, so
// paths inside the archive are never used to write anything. Stored (0) and
// deflated (8) entries are supported; encrypted ones and ZIP64 archives are not.

import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export class ZipError extends Error {}

function findEndOfCentralDirectory(buf) {
  // The record is 22 bytes plus an optional comment of up to 65535 bytes.
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

// Returns Map<lowercased base name, Buffer>. `maxEntryBytes` caps each entry's
// uncompressed size (checked against the header and enforced while inflating, so
// a zip bomb can't exhaust memory).
export function readZipEntries(buf, wanted, { maxEntryBytes = 50 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('not a zip archive');
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new ZipError('not a zip archive');

  const total = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || total === 0xffff) throw new ZipError('ZIP64 archives are not supported');

  const want = new Set([...wanted].map((n) => n.toLowerCase()));
  const out = new Map();
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) throw new ZipError('corrupt zip directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + nameLen + extraLen + commentLen;

    const base = rawName.split(/[/\\]/).pop().toLowerCase();
    if (!base || !want.has(base) || out.has(base)) continue;
    if (flags & 0x1) throw new ZipError('encrypted zip entries are not supported');
    if (size > maxEntryBytes) throw new ZipError(`${base} is too large`);

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOC_SIG) {
      throw new ZipError('corrupt zip entry');
    }
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const data = buf.subarray(start, start + compSize);
    if (data.length !== compSize) throw new ZipError('truncated zip archive');

    let content;
    if (method === 0) content = Buffer.from(data);
    else if (method === 8) {
      try {
        content = zlib.inflateRawSync(data, { maxOutputLength: maxEntryBytes });
      } catch {
        throw new ZipError(`${base} could not be decompressed`);
      }
    } else throw new ZipError(`${base} uses an unsupported compression method`);
    out.set(base, content);
  }
  return out;
}
