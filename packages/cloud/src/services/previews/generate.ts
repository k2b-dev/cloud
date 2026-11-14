import { renderPdfPages } from "../../ai/pdf-render";
import type { PreviewSourceKind } from "../../shared/previews";
import { convertOfficeToPdf } from "../pdf/gotenberg";
import { preparePdfImage } from "../pdf/image";
import { textExcerpt } from "./text";
import { PREVIEW_LIMITS, type PreviewArtifacts, PreviewGenerationError, type PreviewReader, type PreviewSource } from "./types";

/** Consume only the configured prefix for text, and enforce actual bytes for binary inputs too. */
export async function readPreviewSource(reader: PreviewReader, source: PreviewSource, kind: PreviewSourceKind, signal: AbortSignal) {
  signal.throwIfAborted();
  const result = await new Promise<ReadableStream<Uint8Array> | Response>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => reader(source, signal))
      .then(
        (value) => {
          signal.removeEventListener("abort", abort);
          if (signal.aborted) {
            void (value instanceof Response ? value.body : value)?.cancel().catch(() => {});
            reject(signal.reason);
          } else resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    if (signal.aborted) abort();
  });
  const body = result instanceof Response ? result.body : result;
  if (result instanceof Response && !result.ok) {
    await body?.cancel();
    throw new PreviewGenerationError("failed", "source_unavailable");
  }
  if (!body) throw new PreviewGenerationError("failed", "source_empty");
  const stream = body.getReader();
  const cancel = () => {
    void stream.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await stream.read();
      signal.throwIfAborted();
      if (next.done) break;
      const available = PREVIEW_LIMITS[kind] - length;
      if (kind === "text") {
        const chunk = next.value.subarray(0, available);
        chunks.push(chunk);
        length += chunk.byteLength;
        if (length === PREVIEW_LIMITS.text) {
          truncated = source.size > length || next.value.byteLength > available;
          break;
        }
      } else {
        if (next.value.byteLength > available) throw new PreviewGenerationError("too_large", "input_too_large");
        length += next.value.byteLength;
        chunks.push(next.value);
      }
    }
    return { bytes: new Uint8Array(Buffer.concat(chunks, length)), truncated };
  } finally {
    signal.removeEventListener("abort", cancel);
    await stream.cancel().catch(() => {});
    stream.releaseLock();
  }
}

export async function generatePreview(
  reader: PreviewReader,
  source: PreviewSource,
  kind: PreviewSourceKind,
  signal: AbortSignal,
): Promise<PreviewArtifacts> {
  const input = await readPreviewSource(reader, source, kind, signal);
  if (kind === "text") {
    const text = textExcerpt(input.bytes, input.truncated);
    if (text === null) throw new PreviewGenerationError("unsupported", "invalid_utf8");
    return { text: new Blob([text], { type: "text/plain; charset=utf-8" }) };
  }
  const artifacts: PreviewArtifacts = {};
  let image = input.bytes;
  if (kind === "office") {
    const { pdf } = await convertOfficeToPdf({ data: new Blob([input.bytes]), name: source.name }, { signal });
    artifacts.pdf = new Blob([new Uint8Array(pdf)], { type: "application/pdf" });
    image = new Uint8Array(pdf);
  }
  if (kind === "pdf" || kind === "office") {
    const rendered = await renderPdfPages(image, [1], signal, { maxInputBytes: PREVIEW_LIMITS.pdf });
    const page = rendered.pages[0];
    if (!page) throw new PreviewGenerationError("failed", "pdf_empty");
    image = new Uint8Array(Buffer.from(page.png, "base64"));
  }
  const prepared = await preparePdfImage(
    {
      data: image,
      boxes: [
        { width: 320, height: 320 },
        { width: 1280, height: 1280 },
      ],
      maxBytes: PREVIEW_LIMITS.image,
      encoding: "preview",
    },
    { signal },
  );
  if (!prepared.ok)
    throw new PreviewGenerationError(
      prepared.code === "too_large" ? "too_large" : prepared.code === "unsupported_format" ? "unsupported" : "failed",
      prepared.code,
    );
  const [small, large] = prepared.variants;
  if (!small || !large) throw new PreviewGenerationError("failed", "encoding_failed");
  // The worker's bytes carry no media type of their own; the stored manifest and the response need it.
  return {
    ...artifacts,
    small: new Blob([small.data], { type: small.type }),
    large: new Blob([large.data], { type: large.type }),
  };
}
