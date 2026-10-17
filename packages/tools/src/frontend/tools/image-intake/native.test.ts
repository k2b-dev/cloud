import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { defaultDeps } from "./intake";

class FakeImage {
  static instances: FakeImage[] = [];
  decoding = "";
  naturalWidth = 48;
  naturalHeight = 32;
  onload?: (() => void) | null;
  onerror?: (() => void) | null;
  src = "";
  constructor() {
    FakeImage.instances.push(this);
  }
}
const original = Object.getOwnPropertyDescriptor(globalThis, "Image");
let createUrl: ReturnType<typeof spyOn<typeof URL, "createObjectURL">>;
let revokeUrl: ReturnType<typeof spyOn<typeof URL, "revokeObjectURL">>;
beforeEach(() => {
  FakeImage.instances = [];
  Object.defineProperty(globalThis, "Image", { configurable: true, value: FakeImage });
  createUrl = spyOn(URL, "createObjectURL").mockReturnValue("blob:intake-test");
  revokeUrl = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  createUrl.mockRestore();
  revokeUrl.mockRestore();
  if (original) Object.defineProperty(globalThis, "Image", original);
  else Reflect.deleteProperty(globalThis, "Image");
});

test("native success revokes its URL and removes event handlers", async () => {
  const pending = defaultDeps.decodeNative(new Blob(), new AbortController().signal);
  const image = FakeImage.instances[0]!;
  expect(image.src).toBe("blob:intake-test");
  image.onload?.();
  expect(await pending).toEqual({ width: 48, height: 32 });
  expect(revokeUrl).toHaveBeenCalledWith("blob:intake-test");
  expect(image.onload).toBeNull();
  expect(image.onerror).toBeNull();
});
test("native errors revoke their URL", async () => {
  const pending = defaultDeps.decodeNative(new Blob(), new AbortController().signal);
  FakeImage.instances[0]!.onerror?.();
  await expect(pending).rejects.toHaveProperty("reason", "decode-failed");
  expect(revokeUrl).toHaveBeenCalledTimes(1);
});
test("cancelling a native decode revokes its URL and settles it", async () => {
  const controller = new AbortController();
  const pending = defaultDeps.decodeNative(new Blob(), controller.signal);
  controller.abort();
  await expect(pending).rejects.toHaveProperty("name", "AbortError");
  expect(FakeImage.instances[0]!.src).toBe("");
  expect(revokeUrl).toHaveBeenCalledTimes(1);
});
test("already aborted signals never allocate a URL", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(defaultDeps.decodeNative(new Blob(), controller.signal)).rejects.toHaveProperty("name", "AbortError");
  expect(createUrl).not.toHaveBeenCalled();
});
