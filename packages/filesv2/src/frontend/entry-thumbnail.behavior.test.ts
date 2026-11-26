import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createRoot } from "solid-js";
import { isServer } from "solid-js/web";
import type { FileEntry } from "../contracts";

/** Each preview request waits until the test answers it; the test sees the signal it was asked with. */
const asked: { url: string; signal: AbortSignal; answer: (state: "ready" | "none") => void }[] = [];
if (!isServer)
  mock.module("./preview-client", () => ({
    previewSource: (entry: FileEntry) => (/\.(jpe?g|png)$/i.test(entry.name) ? "image" : null),
    previewUrl: (baseId: string, entry: FileEntry, variant: string) => `/preview/${baseId}/${entry.path}/${variant}`,
    loadPreview: (url: string, signal: AbortSignal) =>
      new Promise((resolve, reject) => {
        asked.push({ url, signal, answer: (state) => resolve({ state }) });
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  }));

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const photo = (name: string): FileEntry => ({ name, path: name, directory: false, size: 1, modified: "2026-11-25T10:00:00.000Z" });

describe("the picture of a photo", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  beforeEach(() => {
    asked.length = 0;
  });
  afterEach(async () => {
    const { forgetThumbnails } = await import("./entry-thumbnail");
    forgetThumbnails();
  });

  test("is asked for once with the folder's signal, shows when drawn, and a photo that is not an image asks nothing", async () => {
    const { entryThumbnail } = await import("./entry-thumbnail");
    const folder = new AbortController();
    const read = () => createRoot(() => entryThumbnail("demo", photo("Front.jpg"), "small", folder.signal));
    expect(read()).toBeUndefined();
    expect(read()).toBeUndefined();
    expect(createRoot(() => entryThumbnail("demo", photo("Plan.pdf"), "small", folder.signal))).toBeUndefined();
    expect(asked.map((each) => each.url)).toEqual(["/preview/demo/Front.jpg/small"]);
    expect(asked[0]!.signal).toBe(folder.signal);
    asked[0]!.answer("ready");
    await flush();
    expect(read()).toBe("/preview/demo/Front.jpg/small");
  });

  test("a folder left behind cancels its waiting previews, and the photo asks again when it shows again", async () => {
    const { entryThumbnail } = await import("./entry-thumbnail");
    const first = new AbortController();
    createRoot(() => entryThumbnail("demo", photo("Front.jpg"), "small", first.signal));
    first.abort();
    await flush();
    const again = new AbortController();
    expect(createRoot(() => entryThumbnail("demo", photo("Front.jpg"), "small", again.signal))).toBeUndefined();
    expect(asked.map((each) => each.signal)).toEqual([first.signal, again.signal]);
  });

  test("forgetting old previews keeps those still being drawn, so a photo is never asked for twice at once", async () => {
    const { entryThumbnail, THUMBNAIL_LIMIT } = await import("./entry-thumbnail");
    const folder = new AbortController();
    const names = Array.from({ length: THUMBNAIL_LIMIT + 5 }, (_, index) => `Foto ${index}.jpg`);
    for (const name of names) createRoot(() => entryThumbnail("demo", photo(name), "small", folder.signal));
    // none has answered yet: asking for the first again joins its running request
    createRoot(() => entryThumbnail("demo", photo(names[0]!), "small", folder.signal));
    expect(asked.length).toBe(names.length);
  });
});
