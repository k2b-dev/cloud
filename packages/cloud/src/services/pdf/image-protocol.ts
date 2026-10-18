import { z } from "zod";

/**
 * Bun already reserves about 270..296 MiB of the 512 MiB data limit. A single 32 MiB input plus 64 MiB RGBA
 * leaves about 120..146 MiB for codecs and temporary buffers. Notebooks defaults to 10 MB attachments.
 */
export const PDF_IMAGE_MAX_INPUT_BYTES = 32 * 1024 * 1024;
/** Bound the number of encoders and the output envelope per call. */
export const PDF_IMAGE_MAX_BOXES = 8;
export const ImageBox = z.object({ width: z.number().int().min(1).max(16383), height: z.number().int().min(1).max(16383) });
export const ImageRequest = z.object({
  boxes: z.array(ImageBox).min(1).max(PDF_IMAGE_MAX_BOXES),
  maxBytes: z.number().int().min(1).max(PDF_IMAGE_MAX_INPUT_BYTES),
  // 240 s is the request idle-timeout ceiling; 30 s matches the PDF page decoder.
  timeoutMs: z.number().int().min(1).max(240_000).default(30_000),
});
export const ImageErrorCode = z.enum(["unsupported_format", "unreadable", "too_large", "timed_out"]);
export const ImageVariantHeader = z.object({
  type: z.enum(["image/jpeg", "image/png"]),
  width: z.number().int().min(1).max(16383),
  height: z.number().int().min(1).max(16383),
  bytes: z.number().int().min(1).max(PDF_IMAGE_MAX_INPUT_BYTES),
});
export const ImageResponse = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), code: ImageErrorCode }),
]);

const ImageFrameHeader = ImageRequest.extend({ bytes: z.number().int().min(0).max(PDF_IMAGE_MAX_INPUT_BYTES) });

const ImageRecord = z.union([ImageVariantHeader.extend({ index: z.number().int().min(0) }).strict(), ImageResponse]);
type ImageVariant = { data: Blob; type: "image/jpeg" | "image/png"; width: number; height: number };

/** Read bounded variant records and their exact bodies, followed by one final status and EOF. */
export async function readImageRecords(
  stream: ReadableStream<Uint8Array>,
  request: Pick<z.infer<typeof ImageRequest>, "boxes" | "maxBytes">,
) {
  const reader = stream.getReader();
  let chunk: Uint8Array = new Uint8Array();
  let offset = 0;
  const more = async () => {
    while (offset === chunk.byteLength) {
      const { done, value } = await reader.read();
      if (done) return false;
      chunk = value;
      offset = 0;
    }
    return true;
  };
  const variants: (ImageVariant | null)[] = request.boxes.map(() => null);
  let count = 0;
  let total = 0;
  try {
    for (;;) {
      const line: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        if (!(await more())) throw new Error("Missing image record.");
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.byteLength : newline;
        length += end - offset;
        if (length > 4096) throw new Error("Image record exceeds 4 KiB.");
        line.push(chunk.subarray(offset, end));
        offset = end + (newline < 0 ? 0 : 1);
        if (newline >= 0) break;
      }
      const record = ImageRecord.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(line, length))));
      if ("ok" in record) {
        if (await more()) throw new Error("Unexpected data after final image record.");
        return record.ok ? { ok: true as const, variants } : record;
      }
      const box = request.boxes[record.index];
      total += record.bytes;
      if (
        ++count > request.boxes.length ||
        !box ||
        variants[record.index] !== null ||
        record.bytes > request.maxBytes ||
        record.width > box.width ||
        record.height > box.height ||
        total > request.boxes.length * request.maxBytes
      ) {
        throw new Error("Image variant exceeds its bounds or repeats an index.");
      }
      const body = new Uint8Array(record.bytes);
      let written = 0;
      while (written < body.byteLength) {
        if (!(await more())) throw new Error("Truncated image variant.");
        const size = Math.min(body.byteLength - written, chunk.byteLength - offset);
        body.set(chunk.subarray(offset, offset + size), written);
        written += size;
        offset += size;
      }
      variants[record.index] = {
        data: new Blob([body], { type: record.type }),
        type: record.type,
        width: record.width,
        height: record.height,
      };
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Read a 4 KiB JSON header, then fill one allocation of exactly the declared input length. */
export function readImageFrame(read: (buffer: Uint8Array, offset: number, length: number) => number) {
  // Async stdin chunks made worker memory nondeterministic under its data limit, so read synchronously.
  const headerBuffer = new Uint8Array(4097);
  let headerBytes = 0;
  let newline = -1;
  while (newline < 0) {
    const size = read(headerBuffer, headerBytes, headerBuffer.byteLength - headerBytes);
    if (size === 0) throw new Error("Missing image frame header.");
    newline = headerBuffer.subarray(0, headerBytes + size).indexOf(10, headerBytes);
    headerBytes += size;
    if (newline < 0 && headerBytes === headerBuffer.byteLength) throw new Error("Image frame header exceeds its limit.");
  }
  const header = ImageFrameHeader.parse(JSON.parse(Buffer.from(headerBuffer.buffer, 0, newline).toString("utf8")));
  const body = new Uint8Array(header.bytes);
  let bodyBytes = headerBytes - newline - 1;
  if (bodyBytes > body.byteLength) throw new Error("Image frame body exceeds its declared length.");
  body.set(headerBuffer.subarray(newline + 1, headerBytes));
  while (bodyBytes < body.byteLength) {
    const size = read(body, bodyBytes, body.byteLength - bodyBytes);
    if (size === 0) throw new Error("Truncated image frame body.");
    bodyBytes += size;
  }
  if (read(headerBuffer, 0, 1) !== 0) throw new Error("Image frame body exceeds its declared length.");
  return { header, body };
}
