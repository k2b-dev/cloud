import { deflateSync } from "node:zlib";

const pngChunk = (type: string, data: Buffer): Buffer => {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(Bun.hash.crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
};

/** A complete 1x1 RGB PNG; dimensions can be changed to exercise header-only limits. */
export const logoPng = (width = 1, height = 1, color = 0): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([0, color, 0, 0]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

/** Minimal JPEG marker fixture, with SOF, SOS and EOI; validation never decodes scan data. */
export const logoJpeg = (width = 1, height = 1): Buffer => {
  const sof = Buffer.from([0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x7f, 0xff, 0xd9])]);
};
