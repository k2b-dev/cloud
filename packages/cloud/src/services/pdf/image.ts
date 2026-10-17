import { z } from "zod";
import { spawnCanvasWorker } from "../../_internal/canvas-worker";
import { type ImageBox, type ImageErrorCode, ImageRequest, PDF_IMAGE_MAX_INPUT_BYTES, readImageRecords } from "./image-protocol";

export { PDF_IMAGE_MAX_BOXES, PDF_IMAGE_MAX_INPUT_BYTES } from "./image-protocol";
/** Integer pixels, 1..16383 per side: a square stays within sharp's default input pixel limit. */
export type PdfImageBox = z.infer<typeof ImageBox>;
export type PdfImageVariant = { data: Blob; type: "image/jpeg" | "image/png"; width: number; height: number };
export type PdfImageErrorCode = z.infer<typeof ImageErrorCode>;
export type PreparePdfImageInput = { data: Uint8Array | Blob; boxes: PdfImageBox[]; maxBytes: number };
/** The deadline includes queue time. Default 30 s matches PDF page decoding; 240 s is the request idle-timeout ceiling. */
export type PreparePdfImageOptions = { signal?: AbortSignal; timeoutMs?: number };
export type PreparePdfImageResult = { ok: true; variants: (PdfImageVariant | null)[] } | { ok: false; code: PdfImageErrorCode };

declare const __CLOUD_PDF_IMAGE_WORKER__: string | undefined;
let activeWorkers = 0;
const waiting: (() => void)[] = [];

async function acquire(signal: AbortSignal) {
  if (signal.aborted) return false;
  if (activeWorkers < 2) {
    activeWorkers++;
    return true;
  }
  return new Promise<boolean>((resolve) => {
    const abort = () => {
      waiting.splice(waiting.indexOf(start), 1);
      resolve(false);
    };
    const start = () => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    };
    waiting.push(start);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else activeWorkers--;
}

/**
 * Fit raw image bytes into 1..8 pixel boxes, without enlargement, in one isolated Linux worker (at most two at once).
 * Opaque images use sRGB JPEG q85; transparency uses PNG. Fitting upright sRGB JPEGs pass through unchanged after a validation decode.
 * Results follow box order; null means that encoding exceeded maxBytes. Invalid arguments throw; image failures return codes.
 * Input is capped at 32 MiB; the largest decoded variant at 16 MiP (64 MiB RGBA, versus about 5.8 MP for A4 at 300 dpi).
 * WebP, GIF, TIFF and AVIF sources are capped at 16 MiP (about 16.8 MP).
 * Bun itself uses about half the 512 MiB data limit; decodes that exhaust the remaining memory return too_large.
 */
export async function preparePdfImage(input: PreparePdfImageInput, options: PreparePdfImageOptions = {}): Promise<PreparePdfImageResult> {
  const request = ImageRequest.parse({ boxes: input.boxes, maxBytes: input.maxBytes, timeoutMs: options.timeoutMs });
  const inputData = z.union([z.instanceof(Uint8Array), z.instanceof(Blob)]).parse(input.data);
  if (process.platform !== "linux") throw new Error("PDF image preparation requires the Linux Cloud runtime with memory isolation.");
  if (options.signal?.aborted) return { ok: false, code: "timed_out" };
  if ((input.data instanceof Blob ? input.data.size : input.data.byteLength) > PDF_IMAGE_MAX_INPUT_BYTES) {
    return { ok: false, code: "too_large" };
  }
  const deadline = Date.now() + request.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let acquired = false;
  try {
    acquired = await acquire(signal);
    if (!acquired || signal.aborted || Date.now() >= deadline) return { ok: false, code: "timed_out" };
    const worker =
      typeof __CLOUD_PDF_IMAGE_WORKER__ === "string"
        ? new URL(__CLOUD_PDF_IMAGE_WORKER__, import.meta.url)
        : new URL("./image-worker.ts", import.meta.url);
    // Bun's file-backed Blobs must be materialized before composing a multipart Blob. A slow read must not keep the
    // slot past the deadline, so the abort settles the wait while the read finishes on its own.
    const data =
      inputData instanceof Blob
        ? new Uint8Array(
            await new Promise<ArrayBuffer>((resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              inputData.arrayBuffer().then(resolve, reject);
            }),
          )
        : inputData;
    if (signal.aborted || Date.now() >= deadline) return { ok: false, code: "timed_out" };
    if (data.byteLength > PDF_IMAGE_MAX_INPUT_BYTES) return { ok: false, code: "too_large" };
    const header = `${JSON.stringify({ ...request, bytes: data.byteLength, timeoutMs: Math.max(1, deadline - Date.now()) })}\n`;
    const child = spawnCanvasWorker(worker, "pdf-image", new Blob([header, data]));
    const stop = () => child.kill("SIGKILL");
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    try {
      const result = await readImageRecords(child.stdout, request);
      if (signal.aborted || Date.now() >= deadline) return { ok: false, code: "timed_out" };
      const exitCode = await child.exited;
      if (signal.aborted || Date.now() >= deadline) return { ok: false, code: "timed_out" };
      if (exitCode !== 0) return { ok: false, code: "unreadable" };
      return result;
    } finally {
      signal.removeEventListener("abort", stop);
      stop();
      await child.exited;
    }
  } catch {
    return { ok: false, code: signal.aborted || Date.now() >= deadline ? "timed_out" : "unreadable" };
  } finally {
    clearTimeout(timer);
    if (acquired) release();
  }
}
