/** The image types menu images take, by the content type a data URL declares, with their file extension. */
export const MENU_IMAGE_TYPES = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif" } as const;
export type MenuImageType = keyof typeof MENU_IMAGE_TYPES;

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);
const ascii = (value: string): number[] => Array.from(value, (char) => char.charCodeAt(0));

/**
 * The image type `bytes` start with, by their signature, or `null` for anything else: PNG `89 50 4E 47 0D 0A 1A 0A`,
 * JPEG `FF D8 FF`, GIF `GIF87a` or `GIF89a`, and WebP `RIFF` with `WEBP` at byte 8.
 */
export const detectImageType = (bytes: Uint8Array): MenuImageType | null => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  return null;
};
