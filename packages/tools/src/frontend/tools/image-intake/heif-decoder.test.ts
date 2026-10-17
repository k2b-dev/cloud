import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HEIF_MAX_PIXELS } from "./formats";
import { decodeHeif, disposeHeifDecoder } from "./heif-decoder";
import { type HeifOptions, ImageIntakeError } from "./intake";

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
  test("worker errors fail all affected jobs and allow the next batch", async () => {
    const first = decodeHeif(photo(), options());
    const second = decodeHeif(photo(), options());
    worker().onerror?.({ preventDefault: () => {} });
    for (const job of [first, second]) await expect(job).rejects.toMatchObject({ reason: "decode-failed" });
    expect(worker().terminated).toBe(true);
    const next = decodeHeif(photo(), options());
    worker().emit({ ready: true });
    await complete(worker());
    await next;
  });
  test("message errors and explicit disposal settle jobs rather than hanging", async () => {
    const bad = decodeHeif(photo(), options());
    worker().onmessageerror?.();
    await expect(bad).rejects.toMatchObject({ reason: "decode-failed" });
    const active = decodeHeif(photo(), options());
    const pending = decodeHeif(photo(), options());
    disposeHeifDecoder();
    await expect(active).rejects.toHaveProperty("name", "AbortError");
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    expect(worker().terminated).toBe(true);
  });
  test("missing browser APIs and construction errors are visible decode failures", async () => {
    for (const name of ["Worker", "OffscreenCanvas"]) {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)!;
      Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
      await expect(decodeHeif(photo(), options())).rejects.toBeInstanceOf(ImageIntakeError);
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
    await expect(decodeHeif(photo(), options())).rejects.toMatchObject({ reason: "decode-failed" });
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
