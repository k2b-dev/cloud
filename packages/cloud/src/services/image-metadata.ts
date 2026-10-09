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

const startsWith = (bytes: Uint8Array, signature: string, offset = 0, end = bytes.length): boolean => {
  if (offset + signature.length > end) return false;
  for (let i = 0; i < signature.length; i++) if (bytes[offset + i] !== signature.charCodeAt(i)) return false;
  return true;
};

// Copy ranges without allocating a view for each segment or chunk.
const copy = (out: Uint8Array, written: number, bytes: Uint8Array, start: number, end: number): number => {
  for (let i = start; i < end; i++) out[written++] = bytes[i]!;
  return written;
};

const exifOrientation = (bytes: Uint8Array, view: DataView, start: number, end: number): number => {
  const bad = () => new ImageMetadataError("JPEG EXIF");
  if (!startsWith(bytes, "Exif\0\0", start, end) || end - start < 14) throw bad();
  const tiff = start + 6;
  const little = startsWith(bytes, "II", tiff, end);
  if (!little && !startsWith(bytes, "MM", tiff, end)) throw bad();
  if (view.getUint16(tiff + 2, little) !== 42) throw bad();
  const ifdOffset = view.getUint32(tiff + 4, little);
  if (ifdOffset < 8 || ifdOffset > end - tiff - 2) throw bad();
  const ifd = tiff + ifdOffset;
  const count = view.getUint16(ifd, little);
  if (ifd + 2 + count * 12 > end) throw bad();
  let orientation = 1;
  let found = false;
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (view.getUint16(entry, little) === 0x0112) {
      if (found || view.getUint16(entry + 2, little) !== 3 || view.getUint32(entry + 4, little) !== 1) throw bad();
      const value = view.getUint16(entry + 8, little);
      orientation = value >= 1 && value <= 8 ? value : 1;
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
  const out = new Uint8Array(bytes.length + 36);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let written = copy(out, 0, bytes, 0, 2);
  let offset = 2;
  let orientation = 1;
  let sawExif = false;
  let frame = false;
  let scan = false;
  let entropy = false;
  let orientationPosition = 2;
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
      written = copy(out, written, bytes, start, offset);
      if (offset >= bytes.length) throw bad();
      entropy = false;
    }
    // libjpeg tolerates extraneous bytes before a marker outside scan data.
    while (offset < bytes.length && bytes[offset] !== 0xff) offset++;
    const start = offset++;
    while (bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) throw bad();
    const marker = bytes[offset++]!;
    if (marker === 0xd9) {
      if (!frame || !scan) throw bad();
      written = copy(out, written, bytes, start, offset);
      if (orientation !== 1) {
        out.copyWithin(orientationPosition + 36, orientationPosition, written);
        out.set(orientationSegment(orientation), orientationPosition);
        written += 36;
      }
      return out.subarray(0, written);
    }
    if (offset > bytes.length - 2) throw bad();
    const length = view.getUint16(offset);
    if (length < 2 || length > bytes.length - offset) throw bad();
    const end = offset + length;
    const payload = offset + 2;
    const size = end - payload;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (frame || size < 6 || size !== 6 + 3 * bytes[payload + 5]! || bytes[payload + 5] === 0) throw bad();
      frame = true;
    }
    if (marker === 0xda) {
      if (!frame || size < 4 || size !== 4 + 2 * bytes[payload]! || bytes[payload] === 0) throw bad();
      scan = true;
      entropy = true;
    }
    if (marker === 0xdc) {
      if (!scan || size !== 2) throw bad();
      entropy = true;
    }
    if (marker === 0xdd && size !== 2) throw bad();
    if (marker === 0xe1 && startsWith(bytes, "Exif\0\0", payload, end)) {
      const value = exifOrientation(bytes, view, payload, end);
      if (sawExif && value !== orientation) throw bad();
      orientation = value;
      sawExif = true;
    }
    if (marker === 0xe0 && startsWith(bytes, "JFIF\0", payload, end)) {
      if (size < 14) throw bad();
      // Keep the JFIF header, discarding the thumbnail and any padding.
      out[written] = 0xff;
      out[written + 1] = 0xe0;
      out[written + 2] = 0;
      out[written + 3] = 16;
      written = copy(out, written + 4, bytes, payload, payload + 14);
      out[written - 2] = 0;
      out[written - 1] = 0;
      if (!scan) orientationPosition = written;
    } else if (
      (marker === 0xe2 && startsWith(bytes, "ICC_PROFILE\0", payload, end)) ||
      (marker === 0xee && startsWith(bytes, "Adobe", payload, end) && size === 12) ||
      isFrame ||
      marker === 0xc4 ||
      marker === 0xcc ||
      marker === 0xdb ||
      marker === 0xdd ||
      marker === 0xdc ||
      marker === 0xda
    ) {
      if (marker === 0xe2 && size < 14) throw bad();
      written = copy(out, written, bytes, start, end);
    } else if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) throw bad();
    offset = end;
  }
  throw bad();
};

const PNG_SIGNATURE = "\x89PNG\r\n\x1a\n";
const fourCC = (type: string): number =>
  type.charCodeAt(0) * 0x1000000 + (type.charCodeAt(1) << 16) + (type.charCodeAt(2) << 8) + type.charCodeAt(3);
const IHDR = fourCC("IHDR"),
  PLTE = fourCC("PLTE"),
  IDAT = fourCC("IDAT"),
  IEND = fourCC("IEND");
const PNG_KEEP = new Set(
  [
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
  ].map(fourCC),
);

const stripPng = (bytes: Uint8Array): Uint8Array => {
  const bad = () => new ImageMetadataError("PNG");
  if (!startsWith(bytes, PNG_SIGNATURE)) throw bad();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Uint8Array(bytes.length);
  let written = copy(out, 0, bytes, 0, 8);
  let offset = 8;
  let header = false;
  let data = false;
  let dataEnded = false;
  while (offset < bytes.length) {
    if (offset > bytes.length - 12) throw bad();
    const size = view.getUint32(offset);
    if (size > bytes.length - offset - 12) throw bad();
    const type = view.getUint32(offset + 4);
    for (let i = offset + 4; i < offset + 8; i++) {
      const char = bytes[i]!;
      if (!(char >= 65 && char <= 90) && !(char >= 97 && char <= 122)) throw bad();
    }
    const end = offset + size + 12;
    if (!header && type !== IHDR) throw bad();
    if (type === IHDR) {
      if (header || size !== 13 || view.getUint32(offset + 8) === 0 || view.getUint32(offset + 12) === 0) throw bad();
      header = true;
    }
    if (type === PLTE && (data || size === 0 || size > 768 || size % 3 !== 0)) throw bad();
    if (type === IDAT) {
      if (dataEnded) throw bad();
      data = true;
    } else if (data) dataEnded = true;
    if (type === IEND) {
      if (size !== 0 || !data) throw bad();
      written = copy(out, written, bytes, offset, end);
      return out.subarray(0, written);
    }
    if (PNG_KEEP.has(type)) written = copy(out, written, bytes, offset, end);
    offset = end;
  }
  throw bad();
};

const VP8X = fourCC("VP8X"),
  VP8 = fourCC("VP8 "),
  VP8L = fourCC("VP8L"),
  ANIM = fourCC("ANIM"),
  ANMF = fourCC("ANMF"),
  ALPH = fourCC("ALPH"),
  ICCP = fourCC("ICCP");

const stripWebp = (bytes: Uint8Array): Uint8Array => {
  const bad = () => new ImageMetadataError("WebP");
  if (bytes.length < 12 || !startsWith(bytes, "WEBP", 8)) throw bad();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = view.getUint32(4, true) + 8;
  if (end < 12 || end > bytes.length || end % 2 !== 0) throw bad();
  const out = new Uint8Array(bytes.length);
  const outputView = new DataView(out.buffer);
  let written = copy(out, 0, bytes, 0, 12);
  let offset = 12;
  let image = false,
    extended = false,
    animated = false,
    animationHeader = false,
    alpha = false;
  const checkCodec = (type: number, start: number, size: number) => {
    if (type === VP8 && (size < 10 || !startsWith(bytes, "\x9d\x01\x2a", start + 3, start + size))) throw bad();
    if (type === VP8L && (size < 5 || bytes[start] !== 0x2f)) throw bad();
  };
  const keepChunk = (start: number, size: number) => {
    written = copy(out, written, bytes, start, start + 8 + size);
    if (size % 2) out[written++] = 0; // Canonical padding matches the previous writer.
  };
  while (offset < end) {
    if (offset > end - 8) throw bad();
    const size = view.getUint32(offset + 4, true);
    const padded = size + (size % 2);
    if (padded > end - offset - 8) throw bad();
    const type = view.getUint32(offset);
    const payload = offset + 8;
    if (type === VP8X) {
      if (extended || offset !== 12 || size !== 10) throw bad();
      extended = true;
      animated = (bytes[payload]! & 2) !== 0;
      const flags = written + 8;
      keepChunk(offset, size);
      out[flags] = out[flags]! & ~0x0c;
    } else if (type === ANIM) {
      if (!animated || animationHeader || image || size !== 6) throw bad();
      animationHeader = true;
      keepChunk(offset, size);
    } else if (type === ANMF) {
      if (!animationHeader || size < 24) throw bad();
      const frameStart = written;
      written = copy(out, written, bytes, offset, payload + 16);
      let cursor = payload + 16;
      const frameEnd = payload + size;
      let frameImage = false,
        frameAlpha = false;
      while (cursor < frameEnd) {
        if (cursor > frameEnd - 8) throw bad();
        const length = view.getUint32(cursor + 4, true);
        const next = cursor + 8 + length + (length % 2);
        if (next > frameEnd) throw bad();
        const kind = view.getUint32(cursor);
        if (kind === VP8 || kind === VP8L) {
          if (frameImage || (frameAlpha && kind === VP8L)) throw bad();
          checkCodec(kind, cursor + 8, length);
          frameImage = true;
          keepChunk(cursor, length);
        } else if (kind === ALPH) {
          if (frameImage || frameAlpha || length === 0) throw bad();
          frameAlpha = true;
          keepChunk(cursor, length);
        }
        cursor = next;
      }
      if (!frameImage) throw bad();
      image = true;
      outputView.setUint32(frameStart + 4, written - frameStart - 8, true);
    } else if (type === VP8 || type === VP8L) {
      if (image || animated || (alpha && type === VP8L)) throw bad();
      checkCodec(type, payload, size);
      image = true;
      keepChunk(offset, size);
    } else if (type === ALPH) {
      if (!extended || image || alpha || size === 0) throw bad();
      alpha = true;
      keepChunk(offset, size);
    } else if (type === ICCP) {
      if (!extended || image || size === 0) throw bad();
      keepChunk(offset, size);
    }
    offset += 8 + padded;
  }
  if (!image || (animated && !animationHeader)) throw bad();
  outputView.setUint32(4, written - 8, true);
  return out.subarray(0, written);
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

// WHATWG data URL processing: URL parsing, percent decoding and forgiving base64.
const trimAscii = (value: string): string => value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
const hexValue = (code: number): number => {
  if (code >= 48 && code <= 57) return code - 48;
  const lower = code | 32;
  return lower >= 97 && lower <= 102 ? lower - 87 : -1;
};
const parseDataUrl = (value: string): { bytes: Uint8Array; essence: string } | null => {
  // Parse like a browser image source: surrounding spaces and embedded tabs or newlines do not hide the scheme.
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "data:") return null;
  url.hash = "";
  const input = url.href.slice(5);
  const comma = input.indexOf(",");
  if (comma < 0) return null;
  let declaration = trimAscii(input.slice(0, comma));
  const semicolon = declaration.lastIndexOf(";");
  const base64 = semicolon >= 0 && trimAscii(declaration.slice(semicolon + 1)).toLowerCase() === "base64";
  if (base64) declaration = trimAscii(declaration.slice(0, semicolon));
  const essence = trimAscii(declaration.split(";", 1)[0]!).toLowerCase();
  const encoded = new TextEncoder().encode(input.slice(comma + 1));
  let written = 0;
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === 37 && i + 2 < encoded.length) {
      const high = hexValue(encoded[i + 1]!);
      const low = hexValue(encoded[i + 2]!);
      if (high >= 0 && low >= 0) {
        encoded[written++] = high * 16 + low;
        i += 2;
        continue;
      }
    }
    encoded[written++] = encoded[i]!;
  }
  const decoded = encoded.subarray(0, written);
  if (!base64) return { bytes: decoded, essence };
  // Latin-1 keeps non-ASCII bytes visible to the alphabet validation.
  let body = Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength)
    .toString("latin1")
    .replace(/[\t\n\f\r ]/g, "");
  if (body.length % 4 === 0) body = body.replace(/={1,2}$/, "");
  if (body.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(body)) throw new ImageMetadataError("base64");
  return { bytes: Buffer.from(body, "base64"), essence };
};

/** Strip inline image data URLs; external URLs and other representations stay unchanged. */
export const stripImageDataUrlMetadata = (value: string): string => {
  const parsed = parseDataUrl(value);
  if (!parsed) return value;
  const stripped = stripImageMetadata(parsed.bytes);
  if (stripped === parsed.bytes) return value;
  return `data:${parsed.essence};base64,${Buffer.from(stripped).toString("base64")}`;
};
