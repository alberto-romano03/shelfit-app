import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// Throw an AbortError if the (optional) signal has been aborted. Used to stop
// long sequential download loops the moment a client disconnects.
export function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  }
}

// Read pixel dimensions from PNG/JPEG headers without an image library.
export function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG: IHDR width/height at bytes 16..24
  if (buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: scan for a Start-Of-Frame marker
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = buf[off + 1];
      const isSof =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc;
      if (isSof) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2;
        continue;
      }
      const len = buf.readUInt16BE(off + 2);
      if (len < 2) break;
      off += 2 + len;
    }
  }
  return null;
}

// Convert an image buffer to a WebP buffer using cwebp. Downscales to maxWidth
// only when the source is wider. Returns null if cwebp is unavailable or the
// conversion fails, so callers can fall back to the original bytes.
export async function toWebp(buf, { quality = 80, maxWidth = 0 } = {}) {
  if (!buf || !buf.length) return null;
  const id = crypto.randomUUID();
  const src = path.join(os.tmpdir(), `shelfit-${id}.src`);
  const out = path.join(os.tmpdir(), `shelfit-${id}.webp`);
  try {
    await fsp.writeFile(src, buf);
    const args = ['-quiet', '-q', String(quality), '-mt'];
    if (maxWidth > 0) {
      const dims = imageSize(buf);
      if (dims && dims.width > maxWidth) args.push('-resize', String(maxWidth), '0');
    }
    args.push(src, '-o', out);
    await execFileP('cwebp', args);
    const webp = await fsp.readFile(out);
    return webp && webp.length ? webp : null;
  } catch {
    return null; // cwebp missing or failed → keep original
  } finally {
    await fsp.rm(src, { force: true }).catch(() => {});
    await fsp.rm(out, { force: true }).catch(() => {});
  }
}

// Detect an image's MIME type from its magic bytes.
export function sniffMime(headerBuf) {
  if (!headerBuf || headerBuf.length < 12) return null;
  if (headerBuf[0] === 0x89 && headerBuf[1] === 0x50) return 'image/png';
  if (headerBuf[0] === 0xff && headerBuf[1] === 0xd8) return 'image/jpeg';
  // GIF: "GIF87a" / "GIF89a" (47 49 46 38).
  if (headerBuf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (
    headerBuf.toString('ascii', 0, 4) === 'RIFF' &&
    headerBuf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}
