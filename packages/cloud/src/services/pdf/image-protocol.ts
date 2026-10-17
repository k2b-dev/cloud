import { z } from "zod";

/** One eighth of the worker's 512 MiB data limit; pixels and encoders share the rest. */
export const PDF_IMAGE_MAX_INPUT_BYTES = 64 * 1024 * 1024;
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

/** Read one bounded JSON line followed by a bounded binary body. */
export async function readImageFrame(stream: ReadableStream<Uint8Array>, headerLimit: number, bodyLimit: number) {
  const reader = stream.getReader();
  const headerChunks: Uint8Array[] = [];
  const bodyChunks: Uint8Array[] = [];
  let headerBytes = 0;
  let bodyBytes = 0;
  let header: unknown;
  let foundHeader = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk = value;
      if (!foundHeader) {
        const newline = chunk.indexOf(10);
        const part = newline < 0 ? chunk : chunk.subarray(0, newline);
        headerBytes += part.byteLength;
        if (headerBytes > headerLimit) throw new Error("Image frame header exceeds its limit.");
        headerChunks.push(part);
        if (newline < 0) continue;
        header = JSON.parse(Buffer.concat(headerChunks).toString("utf8"));
        foundHeader = true;
        chunk = chunk.subarray(newline + 1);
      }
      bodyBytes += chunk.byteLength;
      if (bodyBytes > bodyLimit) throw new Error("Image frame body exceeds its limit.");
      bodyChunks.push(chunk);
    }
    if (!foundHeader) throw new Error("Missing image frame header.");
    return { header, body: Buffer.concat(bodyChunks, bodyBytes) };
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
