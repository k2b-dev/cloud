import { deflateSync } from "node:zlib";

export const imageBytes = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.concat(parts));
export const imageText = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

export const jpegSegment = (marker: number, payload: Uint8Array): Uint8Array<ArrayBuffer> =>
  imageBytes(new Uint8Array([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload);

/** Tiny camera EXIF: orientation, Make=Apple, and GPS latitude 51 degrees. */
export const cameraExif = (orientation = 6, little = false): Uint8Array<ArrayBuffer> => {
  const tiff = new Uint8Array(98);
  const view = new DataView(tiff.buffer);
  tiff.set(imageText(little ? "II" : "MM"));
  view.setUint16(2, 42, little);
  view.setUint32(4, 8, little);
  view.setUint16(8, 3, little);
  const entry = (offset: number, tag: number, type: number, count: number, value: number) => {
    view.setUint16(offset, tag, little);
    view.setUint16(offset + 2, type, little);
    view.setUint32(offset + 4, count, little);
    if (type === 3 && count === 1) view.setUint16(offset + 8, value, little);
    else view.setUint32(offset + 8, value, little);
  };
  entry(10, 0x0112, 3, 1, orientation);
  entry(22, 0x010f, 2, 6, 50);
  entry(34, 0x8825, 4, 1, 56);
  tiff.set(imageText("Apple\0"), 50);
  view.setUint16(56, 1, little);
  entry(58, 2, 5, 3, 74);
  view.setUint32(74, 51, little);
  for (const offset of [78, 86, 94]) view.setUint32(offset, 1, little);
  return imageBytes(imageText("Exif\0\0"), tiff);
};

export const withCameraMetadata = (jpeg: Uint8Array, orientation = 6, little = false): Uint8Array<ArrayBuffer> =>
  imageBytes(
    jpeg.subarray(0, 2),
    jpegSegment(0xe1, cameraExif(orientation, little)),
    jpegSegment(0xe1, imageText("http://ns.adobe.com/xap/1.0/\0GPS_LOCATION_XMP")),
    jpegSegment(0xed, imageText("IPTC device serial")),
    jpegSegment(0xfe, imageText("private comment")),
    jpegSegment(0xeb, imageText("foreign APP11")),
    jpeg.subarray(2),
    imageText("trailing polyglot GPS"),
  );

export const pngChunk = (type: string, payload: Uint8Array): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(payload.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, payload.length);
  bytes.set(imageText(type), 4);
  bytes.set(payload, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, bytes.length - 4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0);
  return bytes;
};

export const tinyPng = (): Uint8Array<ArrayBuffer> => {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, 3);
  view.setUint32(4, 2);
  header[8] = 8;
  header[9] = 2;
  return imageBytes(
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(new Uint8Array([0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]))),
    pngChunk("IEND", new Uint8Array()),
  );
};

export const tinyJpeg = async (progressive = false): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await new Bun.Image(tinyPng()).jpeg({ progressive }).bytes());

export const riffChunk = (type: string, payload: Uint8Array): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(8 + payload.length + (payload.length % 2));
  bytes.set(imageText(type));
  new DataView(bytes.buffer).setUint32(4, payload.length, true);
  bytes.set(payload, 8);
  return bytes;
};

export const webpRiff = (...chunks: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const bytes = imageBytes(imageText("RIFF\0\0\0\0WEBP"), ...chunks);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  return bytes;
};
