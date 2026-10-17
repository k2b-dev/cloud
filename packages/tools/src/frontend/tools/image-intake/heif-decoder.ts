import source from "libheif-js/libheif-wasm/libheif-bundle.js" with { type: "text" };
import { type HeifOptions, ImageIntakeError } from "./intake";

// The UMD factory and its synchronous wasm compilation run only in this worker.
const handler = `
const heif = libheif();
self.onmessage = async ({ data: { id, bytes, maxPixels } }) => {
  let images = [];
  try {
    if (typeof OffscreenCanvas === "undefined") throw new Error();
    images = new heif.HeifDecoder().decode(new Uint8Array(bytes));
    const image = images.find(image => image.is_primary()) || images[0];
    if (!image) throw new Error();
    const width = image.get_width(), height = image.get_height();
    if (!(width > 0 && height > 0)) throw new Error();
    if (width * height > maxPixels) {
      self.postMessage({ id, error: "too-large" });
      return;
    }
    const pixels = await new Promise((resolve, reject) => image.display(
      new ImageData(width, height), data => data ? resolve(data) : reject(new Error())
    ));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error();
    context.putImageData(pixels, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    self.postMessage({ id, blob, width, height });
  } catch {
    self.postMessage({ id, error: "decode-failed" });
  } finally {
    for (const image of images) image.free();
  }
};
self.postMessage({ ready: true });
`;

type Reply =
  | { ready: true }
  | { id: number; blob: Blob; width: number; height: number }
  | { id: number; error: "too-large" | "decode-failed" };
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
function failBatch() {
  const jobs = [...(active ? [active] : []), ...queue.splice(0)];
  active = undefined;
  stopWorker();
  for (const job of jobs) settle(job, new ImageIntakeError("decode-failed"));
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
      failBatch();
      return;
    }
    if (!worker) {
      job.options.onStage("loading-decoder");
      workerUrl = URL.createObjectURL(new Blob([source, "\n", handler], { type: "text/javascript" }));
      worker = new Worker(workerUrl);
      worker.onerror = (event) => {
        event.preventDefault();
        failBatch();
      };
      worker.onmessageerror = failBatch;
      worker.onmessage = ({ data }: MessageEvent<Reply>) => {
        if ("ready" in data) {
          ready = true;
          if (active && worker) void send(active, worker);
          return;
        }
        if (!active || data.id !== active.id) return;
        const completed = active;
        active = undefined;
        if ("error" in data) settle(completed, new ImageIntakeError(data.error));
        else settle(completed, undefined, data.blob);
        pump();
      };
    } else if (ready) void send(job, worker);
  } catch {
    failBatch();
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
