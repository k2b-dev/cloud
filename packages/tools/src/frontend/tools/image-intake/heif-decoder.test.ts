import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveObjectURL } from "node:buffer";
import { runInNewContext } from "node:vm";
import { HEIF_MAX_PIXELS } from "./formats";
import { decodeHeif, disposeHeifDecoder } from "./heif-decoder";
import type { HeifOptions } from "./intake";

type Request = { id: number; bytes: ArrayBuffer; maxPixels: number };
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { preventDefault: () => void }) => void;
  onmessageerror?: () => void;
  terminated = false;
  readonly posted = Promise.withResolvers<Request>();
  messages: Request[] = [];
  constructor(readonly url: string) {
    FakeWorker.instances.push(this);
  }
  postMessage(message: Request, transfer: ArrayBuffer[]) {
    expect(transfer).toEqual([message.bytes]);
    this.messages.push(message);
    this.posted.resolve(message);
  }
  terminate() {
    this.terminated = true;
  }
  emit(data: unknown) {
    this.onmessage?.({ data });
  }
}
const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
const originalCanvas = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");
const photo = () => new File(["heif"], "photo.heic", { type: "image/heic" });
const options = (controller = new AbortController(), stages: string[] = []): HeifOptions => ({
  signal: controller.signal,
  onStage: (stage) => stages.push(stage),
  maxPixels: HEIF_MAX_PIXELS,
});
const worker = () => FakeWorker.instances.at(-1)!;
const complete = async (target: FakeWorker, blob = new Blob(["png"], { type: "image/png" })) => {
  const request = await target.posted.promise;
  target.emit({ id: request.id, blob, width: 48, height: 32 });
  return blob;
};
beforeEach(() => {
  FakeWorker.instances = [];
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
  Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, value: class {} });
});
afterEach(() => {
  disposeHeifDecoder();
  if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
  else Reflect.deleteProperty(globalThis, "Worker");
  if (originalCanvas) Object.defineProperty(globalThis, "OffscreenCanvas", originalCanvas);
  else Reflect.deleteProperty(globalThis, "OffscreenCanvas");
});

describe("HEIF worker lifecycle", () => {
  test("serializes jobs in one worker, transfers bytes and terminates at the end", async () => {
    const stages: string[] = [];
    const first = decodeHeif(photo(), options(undefined, stages));
    const second = decodeHeif(photo(), options());
    const target = worker();
    expect(FakeWorker.instances).toHaveLength(1);
    expect(target.messages).toHaveLength(0);
    expect(stages).toEqual(["loading-decoder"]);
    target.emit({ ready: true });
    const request = await target.posted.promise;
    expect(request.maxPixels).toBe(HEIF_MAX_PIXELS);
    const blob = await complete(target);
    expect(await first).toBe(blob);
    expect(target.terminated).toBe(false);
    // The second file's ArrayBuffer resolves in the following microtask.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(target.messages).toHaveLength(2);
    target.emit({ id: target.messages[1]!.id, blob, width: 48, height: 32 });
    expect(await second).toBe(blob);
    expect(target.terminated).toBe(true);
    expect(stages).toEqual(["loading-decoder", "decoding"]);
  });
  test("removes an aborted pending job without interrupting the running job", async () => {
    const first = decodeHeif(photo(), options());
    const pendingController = new AbortController();
    const pending = decodeHeif(photo(), options(pendingController));
    pendingController.abort();
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    const target = worker();
    expect(target.terminated).toBe(false);
    target.emit({ ready: true });
    await complete(target);
    await first;
    expect(target.messages).toHaveLength(1);
    expect(target.terminated).toBe(true);
  });
  test("aborting the running job terminates its worker and continues the queue", async () => {
    const controller = new AbortController();
    const first = decodeHeif(photo(), options(controller));
    const second = decodeHeif(photo(), options());
    const old = worker();
    controller.abort();
    await expect(first).rejects.toHaveProperty("name", "AbortError");
    expect(old.terminated).toBe(true);
    expect(FakeWorker.instances).toHaveLength(2);
    const replacement = worker();
    replacement.emit({ ready: true });
    await complete(replacement);
    await second;
    expect(replacement.terminated).toBe(true);
  });
  test("errors before ready fail the batch as decoder unavailable and allow the next batch", async () => {
    const first = decodeHeif(photo(), options());
    const second = decodeHeif(photo(), options());
    worker().onerror?.({ preventDefault: () => {} });
    for (const job of [first, second]) await expect(job).rejects.toMatchObject({ reason: "decoder-unavailable" });
    expect(worker().terminated).toBe(true);
    const next = decodeHeif(photo(), options());
    worker().emit({ ready: true });
    await complete(worker());
    await next;
  });
  test("message errors and explicit disposal settle jobs rather than hanging", async () => {
    const bad = decodeHeif(photo(), options());
    worker().onmessageerror?.();
    await expect(bad).rejects.toMatchObject({ reason: "decoder-unavailable" });
    const active = decodeHeif(photo(), options());
    const pending = decodeHeif(photo(), options());
    disposeHeifDecoder();
    await expect(active).rejects.toHaveProperty("name", "AbortError");
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    expect(worker().terminated).toBe(true);
  });
  test("missing browser APIs and construction errors report decoder unavailable", async () => {
    for (const name of ["Worker", "OffscreenCanvas"]) {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)!;
      Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
      await expect(decodeHeif(photo(), options())).rejects.toMatchObject({ reason: "decoder-unavailable" });
      Object.defineProperty(globalThis, name, descriptor);
    }
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: class {
        constructor() {
          throw new Error("Worker unavailable");
        }
      },
    });
    await expect(decodeHeif(photo(), options())).rejects.toMatchObject({ reason: "decoder-unavailable" });
  });
  for (const event of ["onerror", "onmessageerror"] as const) {
    test(`${event} after ready remains a decode failure`, async () => {
      const result = decodeHeif(photo(), options());
      worker().emit({ ready: true });
      await worker().posted.promise;
      worker()[event]?.({ preventDefault: () => {} });
      await expect(result).rejects.toMatchObject({ reason: "decode-failed" });
      expect(worker().terminated).toBe(true);
    });
  }
  test("a fatal reply restarts the decoder and preserves the remaining queue order", async () => {
    const first = decodeHeif(photo(), options());
    const second = decodeHeif(photo(), options());
    const third = decodeHeif(photo(), options());
    const old = worker();
    old.emit({ ready: true });
    const request = await old.posted.promise;
    old.emit({ id: request.id, error: "decode-failed", fatal: true });
    await expect(first).rejects.toMatchObject({ reason: "decode-failed" });
    expect(old.terminated).toBe(true);
    expect(FakeWorker.instances).toHaveLength(2);
    const replacement = worker();
    expect(replacement.messages).toHaveLength(0);
    replacement.emit({ ready: true });
    const blob = await complete(replacement);
    expect(await second).toBe(blob);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replacement.messages.map((message) => message.id)).toEqual([request.id + 1, request.id + 2]);
    replacement.emit({ id: replacement.messages[1]!.id, blob, width: 48, height: 32 });
    expect(await third).toBe(blob);
  });
  test("normal decode failures continue with the same worker", async () => {
    const first = decodeHeif(photo(), options());
    const second = decodeHeif(photo(), options());
    const target = worker();
    target.emit({ ready: true });
    const request = await target.posted.promise;
    target.emit({ id: request.id, error: "decode-failed" });
    await expect(first).rejects.toMatchObject({ reason: "decode-failed" });
    expect(target.terminated).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const blob = new Blob(["png"]);
    target.emit({ id: target.messages[1]!.id, blob, width: 48, height: 32 });
    expect(await second).toBe(blob);
    expect(FakeWorker.instances).toHaveLength(1);
  });
  test("worker allocation errors retain their reason", async () => {
    const result = decodeHeif(photo(), options());
    worker().emit({ ready: true });
    const request = await worker().posted.promise;
    worker().emit({ id: request.id, error: "too-large" });
    await expect(result).rejects.toMatchObject({ reason: "too-large" });
    expect(worker().terminated).toBe(true);
  });
});

// Execute the actual worker handler with a small libheif fixture, without a browser or wasm.
async function workerRuntime(stride = 8) {
  const pending = decodeHeif(photo(), options());
  const source = await resolveObjectURL(worker().url)!.text();
  disposeHeifDecoder();
  await expect(pending).rejects.toHaveProperty("name", "AbortError");
  const offset = source.lastIndexOf("\nconst heif = libheif();");
  expect(offset).toBeGreaterThanOrEqual(0);
  const freed: string[] = [];
  const replies: unknown[] = [];
  let pixels: Uint8ClampedArray | undefined;
  const data = new Uint8Array(stride * 2).fill(255);
  data.set([1, 2, 3, 4, 5, 6, 7, 8]);
  data.set([9, 10, 11, 12, 13, 14, 15, 16], stride);
  const image = {
    handle: 1,
    is_primary: () => true,
    get_width: () => 2,
    get_height: () => 2,
    free: () => freed.push("handle"),
  };
  const result = { code: 0, image: 2, channels: [{ id: 1, stride, width: 2, height: 2, data }] };
  const heif = {
    HeifDecoder: class {
      decoder: number | null = 3;
      decode() {
        return [image];
      }
    },
    heif_js_decode_image2: async () => result,
    heif_image_release: (handle: number) => {
      expect(handle).toBe(2);
      freed.push("pixels");
    },
    heif_context_free: (handle: number) => {
      expect(handle).toBe(3);
      freed.push("context");
    },
    heif_colorspace: { heif_colorspace_RGB: 1 },
    heif_chroma: { heif_chroma_interleaved_RGBA: 1 },
    heif_channel: { heif_channel_interleaved: 1 },
  };
  const self = {
    postMessage: (reply: unknown) => replies.push(reply),
    onmessage: async (_event: { data: Request }) => {},
    onerror: (_event: { preventDefault: () => void }) => {},
    onunhandledrejection: (_event: { preventDefault: () => void }) => {},
  };
  runInNewContext(source.slice(offset), {
    libheif: () => heif,
    self,
    ImageData: class {
      data = new Uint8ClampedArray(16);
    },
    OffscreenCanvas: class {
      getContext() {
        return {
          putImageData: (image: { data: Uint8ClampedArray }) => {
            pixels = image.data;
          },
        };
      }
      async convertToBlob() {
        return new Blob(["png"], { type: "image/png" });
      }
    },
  });
  const run = () => self.onmessage({ data: { id: 42, bytes: new ArrayBuffer(0), maxPixels: 4 } });
  return {
    heif,
    result,
    freed,
    replies,
    run,
    self,
    get pixels() {
      return pixels;
    },
  };
}

describe("HEIF worker decoding", () => {
  for (const stride of [8, 12]) {
    test(`copies RGBA rows with stride ${stride} and frees pixels, handles and context`, async () => {
      const runtime = await workerRuntime(stride);
      await runtime.run();
      expect(Array.from(runtime.pixels!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      expect(runtime.freed).toEqual(["pixels", "handle", "context"]);
      expect(runtime.replies.at(-1)).toMatchObject({ id: 42, width: 2, height: 2 });
    });
  }
  test("a returned decode error frees allocations and is not fatal", async () => {
    const runtime = await workerRuntime();
    runtime.result.code = 1;
    await runtime.run();
    expect(runtime.replies.at(-1)).toEqual({ id: 42, error: "decode-failed" });
    expect(runtime.freed).toEqual(["pixels", "handle", "context"]);
  });
  test("a rejected decode posts a fatal failure and frees the handles and context", async () => {
    const runtime = await workerRuntime();
    runtime.heif.heif_js_decode_image2 = async () => {
      throw new Error("wasm abort");
    };
    await runtime.run();
    expect(runtime.replies.at(-1)).toEqual({ id: 42, error: "decode-failed", fatal: true });
    expect(runtime.freed).toEqual(["handle", "context"]);
  });
  for (const event of ["onerror", "onunhandledrejection"] as const) {
    test(`${event} reports the job in progress`, async () => {
      const runtime = await workerRuntime();
      const running = runtime.run();
      runtime.self[event]({ preventDefault: () => {} });
      expect(runtime.replies.at(-1)).toEqual({ id: 42, error: "decode-failed", fatal: true });
      await running;
    });
  }
});
