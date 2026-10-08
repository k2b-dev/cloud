import { HTTPException } from "hono/http-exception";

/** A recognized image container cannot be safely stripped. Hono maps this to 422. */
export class ImageMetadataError extends HTTPException {
  readonly code = "MALFORMED_IMAGE";

  constructor(format: string) {
    const message = `Malformed ${format} image.`;
    super(422, { message, res: Response.json({ message, code: "MALFORMED_IMAGE" }, { status: 422 }) });
    this.name = "ImageMetadataError";
  }
}

const startsWith = (bytes: Uint8Array, signature: string, offset = 0): boolean =>
  offset + signature.length <= bytes.length && [...signature].every((char, i) => bytes[offset + i] === char.charCodeAt(0));

const join = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const exifOrientation = (payload: Uint8Array): number => {
  const bad = () => new ImageMetadataError("JPEG EXIF");
  if (!startsWith(payload, "Exif\0\0") || payload.length < 14) throw bad();
  const tiff = payload.subarray(6);
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const little = startsWith(tiff, "II");
  if (!little && !startsWith(tiff, "MM")) throw bad();
  if (view.getUint16(2, little) !== 42) throw bad();
  const ifd = view.getUint32(4, little);
  if (ifd < 8 || ifd > tiff.length - 2) throw bad();
  const count = view.getUint16(ifd, little);
  const end = ifd + 2 + count * 12;
  if (end > tiff.length - 4) throw bad();
  const next = view.getUint32(end, little);
  if (next !== 0 && (next < 8 || next > tiff.length - 2)) throw bad();
  let orientation = 1;
  let found = false;
  // TIFF field widths; out-of-line IFD0 values must also be within the APP1 payload.
  const widths = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    const tag = view.getUint16(entry, little);
    const type = view.getUint16(entry + 2, little);
    const length = view.getUint32(entry + 4, little);
    const width = widths[type];
    if (!width) throw bad();
    const size = length * width;
    if (size > 4) {
      const offset = view.getUint32(entry + 8, little);
      if (offset < 8 || size > tiff.length - offset) throw bad();
    }
    if (tag === 0x0112) {
      if (found || type !== 3 || length !== 1) throw bad();
      orientation = view.getUint16(entry + 8, little);
      if (orientation < 1 || orientation > 8) throw bad();
      found = true;
    }
  }
  return orientation;
};

const orientationSegment = (orientation: number): Uint8Array =>
  new Uint8Array([
    0xff,
    0xe1,
    0,
    34,
    69,
    120,
    105,
    102,
    0,
    0,
    77,
    77,
    0,
    42,
    0,
    0,
    0,
    8,
    0,
    1,
    1,
    18,
    0,
    3,
    0,
    0,
    0,
    1,
    0,
    orientation,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);

const stripJpeg = (bytes: Uint8Array): Uint8Array => {
  const bad = () => new ImageMetadataError("JPEG");
  const parts = [bytes.subarray(0, 2)];
  let offset = 2;
  let orientation = 1;
  let sawExif = false;
  let frame = false;
  let scan = false;
  let entropy = false;
  let orientationPosition = 1;
  while (offset < bytes.length) {
    if (entropy) {
      const start = offset;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset++;
          continue;
        }
        const markerStart = offset++;
        while (bytes[offset] === 0xff) offset++;
        if (offset >= bytes.length) throw bad();
        const marker = bytes[offset]!;
        if (marker === 0 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset++;
          continue;
        }
        offset = markerStart;
        break;
      }
      parts.push(bytes.subarray(start, offset));
      if (offset >= bytes.length) throw bad();
      entropy = false;
    }
    const start = offset;
    if (bytes[offset++] !== 0xff) throw bad();
    while (bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) throw bad();
    const marker = bytes[offset++]!;
    if (marker === 0xd9) {
      if (!frame || !scan) throw bad();
      parts.push(bytes.subarray(start, offset));
      if (orientation !== 1) parts.splice(orientationPosition, 0, orientationSegment(orientation));
      return join(parts);
    }
    if (offset > bytes.length - 2) throw bad();
    const length = bytes[offset]! * 256 + bytes[offset + 1]!;
    if (length < 2 || length > bytes.length - offset) throw bad();
    const end = offset + length;
    const payload = bytes.subarray(offset + 2, end);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      if (frame || payload.length < 6 || payload.length !== 6 + 3 * payload[5]! || payload[5] === 0) throw bad();
      frame = true;
    }
    if (marker === 0xda) {
      if (!frame || payload.length < 4 || payload.length !== 4 + 2 * payload[0]! || payload[0] === 0) throw bad();
      scan = true;
      entropy = true;
    }
    if (marker === 0xdc) {
      if (!scan || payload.length !== 2) throw bad();
      entropy = true; // DNL may interrupt an entropy-coded scan.
    }
    if (marker === 0xdd && payload.length !== 2) throw bad();
    if (marker === 0xe1 && startsWith(payload, "Exif")) {
      const value = exifOrientation(payload);
      if (sawExif && value !== orientation) throw bad();
      orientation = value;
      sawExif = true;
    }
    if (marker === 0xe0 && startsWith(payload, "JFIF\0")) {
      if (payload.length < 14 || payload.length !== 14 + 3 * payload[12]! * payload[13]!) throw bad();
      // JFIF thumbnails can disclose the unstripped original. Keep only the header.
      const jfif = join([new Uint8Array([0xff, 0xe0, 0, 16]), payload.subarray(0, 14)]);
      jfif[16] = 0;
      jfif[17] = 0;
      parts.push(jfif);
      if (!scan) orientationPosition = parts.length;
    } else if (
      (marker === 0xe2 && startsWith(payload, "ICC_PROFILE\0")) ||
      (marker === 0xee && startsWith(payload, "Adobe") && payload.length === 12) ||
      isFrame ||
      [0xc4, 0xcc, 0xdb, 0xdd, 0xdc, 0xda].includes(marker)
    ) {
      if (marker === 0xe2 && payload.length < 14) throw bad();
      parts.push(bytes.subarray(start, end));
    } else if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) {
      throw bad();
    }
    offset = end;
  }
  throw bad();
};

const PNG_SIGNATURE = "\x89PNG\r\n\x1a\n";
const PNG_KEEP = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "cHRM",
  "gAMA",
  "iCCP",
  "sBIT",
  "sRGB",
  "cICP",
  "mDCV",
  "cLLI",
  "tRNS",
  "bKGD",
  "pHYs",
  "acTL",
  "fcTL",
  "fdAT",
]);

const stripPng = (bytes: Uint8Array): Uint8Array => {
  const bad = () => new ImageMetadataError("PNG");
  if (!startsWith(bytes, PNG_SIGNATURE)) throw bad();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [bytes.subarray(0, 8)];
  let offset = 8;
  let header = false;
  let data = false;
  let dataEnded = false;
  while (offset < bytes.length) {
    if (offset > bytes.length - 12) throw bad();
    const size = view.getUint32(offset);
    if (size > bytes.length - offset - 12) throw bad();
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type)) throw bad();
    const end = offset + size + 12;
    if (!header && type !== "IHDR") throw bad();
    if (type === "IHDR") {
      if (header || size !== 13 || view.getUint32(offset + 8) === 0 || view.getUint32(offset + 12) === 0) throw bad();
      header = true;
    }
    if (type === "PLTE" && (data || size === 0 || size > 768 || size % 3 !== 0)) throw bad();
    if (type === "IDAT") {
      if (dataEnded) throw bad();
      data = true;
    } else if (data) dataEnded = true;
    if (type === "IEND") {
      if (size !== 0 || !data) throw bad();
      parts.push(bytes.subarray(offset, end));
      return join(parts);
    }
    if (PNG_KEEP.has(type)) parts.push(bytes.subarray(offset, end));
    offset = end;
  }
  throw bad();
};

const webpChunk = (type: string, payload: Uint8Array): Uint8Array => {
  const chunk = new Uint8Array(8 + payload.length + (payload.length % 2));
  for (let i = 0; i < 4; i++) chunk[i] = type.charCodeAt(i);
  new DataView(chunk.buffer).setUint32(4, payload.length, true);
  chunk.set(payload, 8);
  return chunk;
};

const stripWebp = (bytes: Uint8Array): Uint8Array => {
  const bad = () => new ImageMetadataError("WebP");
  if (bytes.length < 12 || !startsWith(bytes, "WEBP", 8)) throw bad();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = view.getUint32(4, true) + 8;
  if (end < 12 || end > bytes.length || end % 2 !== 0) throw bad();
  const parts: Uint8Array[] = [];
  let offset = 12;
  let image = false;
  let extended = false;
  let animated = false;
  let animationHeader = false;
  let alpha = false;
  const checkCodec = (type: string, payload: Uint8Array) => {
    if (type === "VP8 " && (payload.length < 10 || !startsWith(payload, "\x9d\x01\x2a", 3))) throw bad();
    if (type === "VP8L" && (payload.length < 5 || payload[0] !== 0x2f)) throw bad();
  };
  while (offset < end) {
    if (offset > end - 8) throw bad();
    const size = view.getUint32(offset + 4, true);
    const padded = size + (size % 2);
    if (padded > end - offset - 8) throw bad();
    const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const payload = bytes.subarray(offset + 8, offset + 8 + size);
    if (type === "VP8X") {
      if (extended || offset !== 12 || size !== 10) throw bad();
      extended = true;
      animated = (payload[0]! & 2) !== 0;
      const flags = payload.slice();
      flags[0] = flags[0]! & ~0x0c; // EXIF and XMP present bits.
      parts.push(webpChunk(type, flags));
    } else if (type === "ANIM") {
      if (!animated || animationHeader || image || size !== 6) throw bad();
      animationHeader = true;
      parts.push(webpChunk(type, payload));
    } else if (type === "ANMF") {
      if (!animationHeader || size < 24) throw bad();
      // A frame is another chunk container. Do not preserve unknown nested metadata.
      const frame = [payload.subarray(0, 16)];
      const frameView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      let cursor = 16;
      let frameImage = false;
      let frameAlpha = false;
      while (cursor < payload.length) {
        if (cursor > payload.length - 8) throw bad();
        const length = frameView.getUint32(cursor + 4, true);
        const frameEnd = cursor + 8 + length + (length % 2);
        if (frameEnd > payload.length) throw bad();
        const kind = String.fromCharCode(...payload.subarray(cursor, cursor + 4));
        const data = payload.subarray(cursor + 8, cursor + 8 + length);
        if (kind === "VP8 " || kind === "VP8L") {
          if (frameImage || (frameAlpha && kind === "VP8L")) throw bad();
          checkCodec(kind, data);
          frameImage = true;
          frame.push(webpChunk(kind, data));
        } else if (kind === "ALPH") {
          if (frameImage || frameAlpha || length === 0) throw bad();
          frameAlpha = true;
          frame.push(webpChunk(kind, data));
        }
        cursor = frameEnd;
      }
      if (!frameImage) throw bad();
      image = true;
      parts.push(webpChunk(type, join(frame)));
    } else if (type === "VP8 " || type === "VP8L") {
      if (image || animated || (alpha && type === "VP8L")) throw bad();
      checkCodec(type, payload);
      image = true;
      parts.push(webpChunk(type, payload));
    } else if (type === "ALPH") {
      if (!extended || image || alpha || size === 0) throw bad();
      alpha = true;
      parts.push(webpChunk(type, payload));
    } else if (type === "ICCP") {
      if (!extended || image || size === 0) throw bad();
      parts.push(webpChunk(type, payload));
    }
    offset += 8 + padded;
  }
  if (!image || (animated && !animationHeader)) throw bad();
  const out = join([bytes.subarray(0, 12), ...parts]);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
};

/**
 * Losslessly removes non-rendering metadata from JPEG, PNG and WebP, selected
 * by magic bytes. Call only for uploads the application classifies as images.
 * Other formats are returned unchanged. No decoding; linear time and space.
 */
export const stripImageMetadata = (bytes: Uint8Array): Uint8Array => {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return stripJpeg(bytes);
  if (startsWith(bytes, "\x89PNG")) return stripPng(bytes);
  if (startsWith(bytes, "RIFF") && startsWith(bytes, "WEBP", 8)) return stripWebp(bytes);
  return bytes;
};

/** Strip inline image data URLs; external URLs and other representations stay unchanged. */
export const stripImageDataUrlMetadata = (value: string): string => {
  const match = value.match(/^(data:image\/[^;,]+;base64,)(.*)$/s);
  if (!match) return value;
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.toString("base64") !== match[2]) throw new ImageMetadataError("base64");
  return match[1] + Buffer.from(stripImageMetadata(bytes)).toString("base64");
};
