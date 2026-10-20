import { open } from "node:fs/promises";

export interface ImageInfo {
  format: "png" | "jpeg" | "gif" | "webp" | "avif" | "svg";
  width?: number;
  height?: number;
}

/** Enough of the file for every header this reads; JPEG SOF markers come after EXIF, which can be long. */
const HEAD_BYTES = 256 * 1024;

/** Reads an image's format and pixel size from its header, without decoding it. */
export async function readImageInfo(path: string): Promise<ImageInfo | null> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return parseImageHeader(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export function parseImageHeader(b: Buffer): ImageInfo | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) {
    return { format: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 10 && b.toString("ascii", 0, 3) === "GIF") {
    return { format: "gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return { format: "jpeg", ...jpegSize(b) };
  if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    return { format: "webp", ...webpSize(b) };
  }
  if (b.length >= 12 && b.toString("ascii", 4, 8) === "ftyp" && /avi[fs]/.test(b.toString("ascii", 8, 12))) {
    return { format: "avif", ...avifSize(b) };
  }
  const text = b.toString("utf8", 0, Math.min(b.length, 1024)).trimStart();
  if (text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg"))) return { format: "svg" };
  return null;
}

function jpegSize(b: Buffer): { width?: number; height?: number } {
  let offset = 2;
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = b[offset + 1]!;
    // SOF0 to SOF15 hold the frame size, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(offset + 5), width: b.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // Markers without a length.
      continue;
    }
    offset += 2 + b.readUInt16BE(offset + 2);
  }
  return {};
}

function webpSize(b: Buffer): { width?: number; height?: number } {
  const chunk = b.toString("ascii", 12, 16);
  if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return {};
}

/** AVIF stores the size in an "ispe" property box; finding the first one is enough for a single-image file. */
function avifSize(b: Buffer): { width?: number; height?: number } {
  const index = b.indexOf("ispe", 0, "ascii");
  if (index === -1 || index + 16 > b.length) return {};
  return { width: b.readUInt32BE(index + 8), height: b.readUInt32BE(index + 12) };
}
