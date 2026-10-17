import source from "libheif-js/libheif-wasm/libheif-bundle.js" with { type: "text" };
import { type HeifOptions, ImageIntakeError } from "./errors";

// The UMD factory and its synchronous wasm compilation run only in this worker.
const handler = `
const heif = libheif();
let currentJobId;
const failJob = () => {
  if (currentJobId !== undefined) self.postMessage({ id: currentJobId, error: "decode-failed", fatal: true });
};
self.onunhandledrejection = event => {
  if (currentJobId === undefined) return;
  event.preventDefault();
  failJob();
};
self.onerror = event => {
  if (currentJobId === undefined) return;
  event.preventDefault();
  failJob();
};
async function decode(bytes, maxPixels) {
  const decoder = new heif.HeifDecoder();
  let images = [];
  try {
    images = decoder.decode(new Uint8Array(bytes));
    const image = images.find(image => image.is_primary()) || images[0];
    if (!image) return { error: "decode-failed" };
    const width = image.get_width(), height = image.get_height();
    if (!(width > 0 && height > 0)) return { error: "decode-failed" };
    if (width * height > maxPixels) return { error: "too-large" };
    const pixels = new ImageData(width, height);
    const result = await heif.heif_js_decode_image2(
      image.handle, heif.heif_colorspace.heif_colorspace_RGB, heif.heif_chroma.heif_chroma_interleaved_RGBA
    );
    try {
      if (!result || result.code) return { error: "decode-failed" };
      for (const channel of result.channels) {
        if (channel.id !== heif.heif_channel.heif_channel_interleaved) continue;
        if (channel.stride === channel.width * 4) pixels.data.set(channel.data);
        else for (let row = 0; row < channel.height; row++) {
          pixels.data.set(channel.data.slice(row * channel.stride, row * channel.stride + channel.width * 4), row * channel.width * 4);
        }
      }
    } finally {
      if (result && result.image) heif.heif_image_release(result.image);
    }
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error();
    context.putImageData(pixels, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return { blob, width, height };
  } finally {
    try {
      for (const image of images) image.free();
    } finally {
      if (decoder.decoder) {
        heif.heif_context_free(decoder.decoder);
        decoder.decoder = null;
      }
    }
  }
}
// A dedicated worker receives messages only from the page that created it, never from other windows.
onmessage = async ({ data: { id, bytes, maxPixels } }) => {
  currentJobId = id;
  try {
    self.postMessage({ id, ...await decode(bytes, maxPixels) });
  } catch {
    failJob();
  } finally {
    currentJobId = undefined;
  }
};
if (typeof OffscreenCanvas === "undefined") throw new Error("OffscreenCanvas unavailable");
self.postMessage({ ready: true });
`;

type Reply =
  | { ready: true }
  | { id: number; blob: Blob; width: number; height: number }
  | { id: number; error: "too-large" | "decode-failed"; fatal?: boolean };
type Job = {
  id: number;
  file: File;
  options: HeifOptions;
  resolve: (blob: Blob) => void;
  reject: (error: unknown) => void;
  abort: () => void;
};
let nextId = 0;
let worker: Worker | undefined;
let workerUrl: string | undefined;
let ready = false;
let active: Job | undefined;
const queue: Job[] = [];

function stopWorker() {
  worker?.terminate();
  worker = undefined;
  if (workerUrl) URL.revokeObjectURL(workerUrl);
  workerUrl = undefined;
  ready = false;
}
function settle(job: Job, error?: unknown, blob?: Blob) {
  job.options.signal.removeEventListener("abort", job.abort);
  if (error) job.reject(error);
  else if (blob) job.resolve(blob);
}
function failBatch(reason: "decoder-unavailable" | "decode-failed" = "decode-failed") {
  const jobs = [...(active ? [active] : []), ...queue.splice(0)];
  active = undefined;
  stopWorker();
  for (const job of jobs) settle(job, new ImageIntakeError(reason));
}
async function send(job: Job, target: Worker) {
  try {
    job.options.onStage("decoding");
    const bytes = await job.file.arrayBuffer();
    if (active !== job || worker !== target) return;
    target.postMessage({ id: job.id, bytes, maxPixels: job.options.maxPixels }, [bytes]);
  } catch {
    if (active === job) failBatch();
  }
}
function pump() {
  if (active) return;
  active = queue.shift();
  if (!active) {
    stopWorker();
    return;
  }
  const job = active;
  try {
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
      failBatch("decoder-unavailable");
      return;
    }
    if (!worker) {
      job.options.onStage("loading-decoder");
      workerUrl = URL.createObjectURL(new Blob([source, "\n", handler], { type: "text/javascript" }));
      worker = new Worker(workerUrl);
      worker.onerror = (event) => {
        event.preventDefault();
        failBatch(ready ? "decode-failed" : "decoder-unavailable");
      };
      worker.onmessageerror = () => failBatch(ready ? "decode-failed" : "decoder-unavailable");
      worker.onmessage = ({ data }: MessageEvent<Reply>) => {
        if ("ready" in data) {
          ready = true;
          if (active && worker) void send(active, worker);
          return;
        }
        if (!active || data.id !== active.id) return;
        const completed = active;
        active = undefined;
        if ("error" in data) {
          if (data.fatal) stopWorker();
          settle(completed, new ImageIntakeError(data.error));
        } else settle(completed, undefined, data.blob);
        pump();
      };
    } else if (ready) void send(job, worker);
  } catch {
    failBatch(ready ? "decode-failed" : "decoder-unavailable");
  }
}

export function decodeHeif(file: File, options: HeifOptions): Promise<Blob> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const job: Job = {
      id: ++nextId,
      file,
      options,
      resolve,
      reject,
      abort: () => {
        if (active === job) {
          active = undefined;
          stopWorker();
        } else {
          const index = queue.indexOf(job);
          if (index >= 0) queue.splice(index, 1);
        }
        settle(job, options.signal.reason);
        pump();
      },
    };
    options.signal.addEventListener("abort", job.abort, { once: true });
    queue.push(job);
    pump();
  });
}

export function disposeHeifDecoder() {
  const jobs = [...(active ? [active] : []), ...queue.splice(0)];
  active = undefined;
  stopWorker();
  for (const job of jobs) settle(job, new DOMException("Image intake disposed", "AbortError"));
}
