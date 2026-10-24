import { ImageMetadataError, stripImageMetadata } from "@k2b/cloud/services/image-metadata";

const signature = (bytes: Uint8Array, text: string, offset = 0) =>
  [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));

/** Read container dimensions without decoding pixels. Input is bounded by the upload budget. */
export const prepareAttachmentContent = async (bytes: Uint8Array, declaredType: string) => {
  const detected = signature(bytes, "\x89PNG\r\n\x1a\n")
    ? "image/png"
    : bytes[0] === 0xff && bytes[1] === 0xd8
      ? "image/jpeg"
      : signature(bytes, "RIFF") && signature(bytes, "WEBP", 8)
        ? "image/webp"
        : signature(bytes, "GIF87a") || signature(bytes, "GIF89a")
          ? "image/gif"
          : null;
  if (!detected) {
    if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(declaredType)) throw new ImageMetadataError("image");
    return { content: bytes, mimeType: declaredType, kind: "file" as const, width: null, height: null };
  }
  const content = stripImageMetadata(bytes);
  let width: number, height: number;
  try {
    ({ width, height } = await new Bun.Image(content).metadata());
  } catch {
    throw new ImageMetadataError(detected);
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 2147483647 || height > 2147483647)
    throw new ImageMetadataError(detected);
  return { content, mimeType: detected, kind: "image" as const, width, height };
};

export const attachmentHeaders = (attachment: { name: string; mimeType: string; kind: "image" | "file" }) => {
  const inline = attachment.kind === "image" && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(attachment.mimeType);
  const fallback = attachment.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(attachment.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return {
    "Content-Type": inline ? attachment.mimeType : "application/octet-stream",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
    "Cache-Control": "private, no-store",
  };
};
