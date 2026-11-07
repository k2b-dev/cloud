export type AttachmentPreviewKind = "image" | "pdf" | "text" | "audio" | "video";

export const IMAGE_PREVIEW_CONTENT_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];
export const MAX_IMAGE_PREVIEW_BYTES = 25 * 1024 * 1024;
const MAX_DOCUMENT_PREVIEW_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

export const baseAttachmentContentType = (contentType: string): string => contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";

export const attachmentPreviewKind = (contentType: string, byteLength: number): AttachmentPreviewKind | null => {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) return null;
  const mime = baseAttachmentContentType(contentType);
  if (IMAGE_PREVIEW_CONTENT_TYPES.includes(mime)) {
    return byteLength <= MAX_IMAGE_PREVIEW_BYTES ? "image" : null;
  }
  if (mime === "application/pdf") return byteLength <= MAX_DOCUMENT_PREVIEW_BYTES ? "pdf" : null;
  if (["text/plain", "text/csv", "application/json"].includes(mime)) {
    return byteLength <= MAX_TEXT_PREVIEW_BYTES ? "text" : null;
  }
  if (["audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "audio/mp4"].includes(mime)) {
    return byteLength <= MAX_DOCUMENT_PREVIEW_BYTES ? "audio" : null;
  }
  if (["video/mp4", "video/webm", "video/ogg"].includes(mime)) {
    return byteLength <= MAX_DOCUMENT_PREVIEW_BYTES ? "video" : null;
  }
  return null;
};

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean => signature.every((value, index) => bytes[index] === value);

const ascii = (bytes: Uint8Array, start: number, length: number): string => String.fromCharCode(...bytes.subarray(start, start + length));

export const attachmentPreviewSignatureMatches = (contentType: string, prefix: Uint8Array): boolean => {
  const mime = baseAttachmentContentType(contentType);
  if (["text/plain", "text/csv", "application/json"].includes(mime)) return true;
  if (mime === "application/pdf") return ascii(prefix, 0, 5) === "%PDF-";
  if (mime === "image/png") return startsWith(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mime === "image/jpeg") return startsWith(prefix, [0xff, 0xd8, 0xff]);
  if (mime === "image/gif") return ascii(prefix, 0, 6) === "GIF87a" || ascii(prefix, 0, 6) === "GIF89a";
  if (mime === "image/webp") return ascii(prefix, 0, 4) === "RIFF" && ascii(prefix, 8, 4) === "WEBP";
  if (mime === "audio/mpeg") return ascii(prefix, 0, 3) === "ID3" || (prefix[0] === 0xff && (prefix[1] ?? 0) >= 0xe0);
  if (mime === "audio/ogg" || mime === "video/ogg") return ascii(prefix, 0, 4) === "OggS";
  if (mime === "audio/wav") return ascii(prefix, 0, 4) === "RIFF" && ascii(prefix, 8, 4) === "WAVE";
  if (mime === "audio/webm" || mime === "video/webm") return startsWith(prefix, [0x1a, 0x45, 0xdf, 0xa3]);
  if (mime === "audio/mp4" || mime === "video/mp4") return ascii(prefix, 4, 4) === "ftyp";
  return false;
};
