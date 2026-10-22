import { fail, ok, type Result } from "@k2b/stdlib";
import { mailboxLogoFailure } from "./mailbox-logo-errors";

export const MAX_MAILBOX_LOGO_BYTES = 102400;
export type MailboxLogoImage = { contentType: "image/png" | "image/jpeg"; width: number; height: number };

const damaged = () => fail(mailboxLogoFailure("damaged"));
const dimensions = (contentType: MailboxLogoImage["contentType"], width: number, height: number): Result<MailboxLogoImage> => {
  if (width < 1 || height < 1) return damaged();
  if (width > 1200 || height > 400) return fail(mailboxLogoFailure("tooManyPixels", { width, height }));
  return ok({ contentType, width, height });
};

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

/** Header-only validation: never decode pixels or trust an upload's media type. */
export const validateMailboxLogoImage = (bytes: Uint8Array): Result<MailboxLogoImage> => {
  if (bytes.byteLength > MAX_MAILBOX_LOGO_BYTES) return fail(mailboxLogoFailure("tooLarge"));
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.length > 0 && data.subarray(0, Math.min(8, data.length)).equals(pngSignature.subarray(0, Math.min(8, data.length)))) {
    if (data.length < 33 || !data.subarray(0, 8).equals(pngSignature)) return damaged();
    if (data.readUInt32BE(8) !== 13 || data.toString("ascii", 12, 16) !== "IHDR") return damaged();
    const size = dimensions("image/png", data.readUInt32BE(16), data.readUInt32BE(20));
    if (!size.ok) return size;
    let offset = 8;
    while (offset < data.length) {
      if (data.length - offset < 12) return damaged();
      const length = data.readUInt32BE(offset);
      if (length > data.length - offset - 12) return damaged();
      const end = offset + 12 + length;
      const type = data.toString("ascii", offset + 4, offset + 8);
      if (crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)) return damaged();
      if (offset !== 8 && type === "IHDR") return damaged();
      if (type === "IEND") return length === 0 && end === data.length ? size : damaged();
      offset = end;
    }
    return damaged();
  }
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xd8) {
    let size: Result<MailboxLogoImage> | null = null;
    let offset = 2;
    while (offset < data.length) {
      if (data[offset++] !== 0xff) return damaged();
      while (data[offset] === 0xff) offset += 1;
      const marker = data[offset++];
      if (marker === undefined || marker === 0 || marker === 0xd8) return damaged();
      if (marker === 0xd9) return offset === data.length && size ? size : damaged();
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) return damaged();
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) return damaged();
      if (marker === 0xe1 && length >= 8 && data.subarray(offset + 2, offset + 8).equals(Buffer.from("Exif\0\0"))) {
        if (length < 16) return damaged();
        const tiff = offset + 8;
        const view = new DataView(data.buffer, data.byteOffset + tiff, offset + length - tiff);
        const little = view.getUint16(0) === 0x4949;
        if (!little && view.getUint16(0) !== 0x4d4d) return damaged();
        if (view.getUint16(2, little) !== 42) return damaged();
        const ifd = view.getUint32(4, little);
        if (ifd < 8 || ifd > view.byteLength - 2) return damaged();
        const count = view.getUint16(ifd, little);
        if (ifd + 2 + count * 12 > view.byteLength) return damaged();
        let found = false;
        for (let i = 0; i < count; i += 1) {
          const entry = ifd + 2 + i * 12;
          if (view.getUint16(entry, little) !== 0x0112) continue;
          if (found || view.getUint16(entry + 2, little) !== 3 || view.getUint32(entry + 4, little) !== 1) return damaged();
          found = true;
          if (view.getUint16(entry + 8, little) !== 1) {
            return fail(mailboxLogoFailure("rotated"));
          }
        }
      }
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && !size) {
        if (length < 8) return damaged();
        size = dimensions("image/jpeg", data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3));
        if (!size.ok) return size;
      }
      offset += length;
      if (marker === 0xda) {
        if (!size) return damaged();
        // Scan data ends at the next real marker, which the outer walk handles.
        // Stuffed FF bytes and restart markers belong to the scan itself.
        while (offset < data.length) {
          if (data[offset] !== 0xff) {
            offset += 1;
            continue;
          }
          const markerOffset = offset;
          while (data[offset] === 0xff) offset += 1;
          const scanMarker = data[offset];
          if (scanMarker === 0 || (scanMarker !== undefined && scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
            offset += 1;
            continue;
          }
          offset = markerOffset;
          break;
        }
      }
    }
    return damaged();
  }
  return fail(mailboxLogoFailure("unsupportedType"));
};
