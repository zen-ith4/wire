const fs = require('fs');

// Reads just enough of an image file to determine its pixel
// dimensions, without pulling in an image-processing dependency
// (sharp/jimp/etc). Used at upload time so the DB can store
// width/height alongside the attachment — the frontend then reserves
// the correct amount of layout space for the placeholder *before*
// the actual image bytes are fetched, instead of guessing.
//
// Supports the four formats accepted by CHAT_MIME_MAP's image types:
// PNG, JPEG, GIF, WebP. Returns null (rather than throwing) for
// anything else, or if the file is truncated/unreadable — callers
// treat "no dimensions" as a normal, expected case.
function readImageDimensions(filePath, mime) {
  try {
    // A handful of KB is always enough: every format below stores its
    // dimensions in the first frame header, well within this range.
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(65536);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.subarray(0, bytesRead);

    if (mime === 'image/png') return readPng(head);
    if (mime === 'image/jpeg') return readJpeg(head);
    if (mime === 'image/gif') return readGif(head);
    if (mime === 'image/webp') return readWebp(head);
    return null;
  } catch {
    return null;
  }
}

function readPng(buf) {
  // 8-byte signature, then an IHDR chunk: 4-byte length, 4-byte type
  // "IHDR", then width/height as big-endian uint32s.
  if (buf.length < 24) return null;
  const isPng =
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!isPng) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return dims(width, height);
}

function readGif(buf) {
  // "GIF87a"/"GIF89a" header, then width/height as little-endian uint16s.
  if (buf.length < 10) return null;
  const sig = buf.toString('ascii', 0, 3);
  if (sig !== 'GIF') return null;
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  return dims(width, height);
}

function readJpeg(buf) {
  // JPEG is a sequence of markers (0xFF followed by a marker byte).
  // Dimensions live in the first SOF (Start Of Frame) marker's
  // segment, which is one of 0xC0-0xC3/0xC5-0xC7/0xC9-0xCB/0xCD-0xCF
  // (excluding the 0xC4/0xC8/0xCC "not a frame" bytes).
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1];
    // Standalone markers with no length/payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segmentLength = buf.readUInt16BE(offset + 2);
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return dims(width, height);
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function readWebp(buf) {
  // RIFF container: "RIFF" + size(4) + "WEBP", then a chunk whose
  // format (VP8 / VP8L / VP8X) determines where width/height sit.
  if (buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }
  const chunkId = buf.toString('ascii', 12, 16);
  if (chunkId === 'VP8X') {
    // 24-bit little-endian width-1 / height-1 starting at byte 24.
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return dims(width, height);
  }
  if (chunkId === 'VP8 ') {
    // Simple lossy format: 14-bit width/height (with 2-bit scale
    // flags in the top bits) as little-endian uint16s at byte 26.
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return dims(width, height);
  }
  if (chunkId === 'VP8L') {
    // Lossless format: a 1-byte signature (0x2f) then a packed
    // 32-bit little-endian field: 14 bits width-1, 14 bits height-1.
    const bits = buf.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return dims(width, height);
  }
  return null;
}

function dims(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

module.exports = { readImageDimensions };
