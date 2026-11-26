import { afterEach, expect, test } from "bun:test";
import { loadPreview } from "./preview-client";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

test("the newest preview waiting is served first, and a cancelled one leaves the queue without a request", async () => {
  const started: string[] = [];
  const answers = new Map<string, () => void>();
  globalThis.fetch = ((url: string) => {
    started.push(url);
    return new Promise<Response>((resolve) => answers.set(url, () => resolve(new Response("x", { status: 200 }))));
  }) as typeof fetch;
  const signal = new AbortController().signal;
  // four fill the page's slots; then a tile far up, a tile far down, and the file just opened wait
  const first = ["a", "b", "c", "d"].map((name) => loadPreview(name, signal));
  const left = new AbortController();
  const old = loadPreview("old", signal);
  const gone = loadPreview("left-view", left.signal).catch(() => "cancelled");
  const newest = loadPreview("opened", signal);
  await Promise.resolve();
  expect(started).toEqual(["a", "b", "c", "d"]);
  left.abort();
  expect(await gone).toBe("cancelled");
  answers.get("a")!();
  await first[0];
  await new Promise((resolve) => setTimeout(resolve, 0));
  // the file opened last comes before the tile that waited longest; the cancelled one never asks
  expect(started.slice(4)).toEqual(["opened"]);
  answers.get("b")!();
  await first[1];
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(started.slice(4)).toEqual(["opened", "old"]);
  for (const name of ["c", "d", "opened", "old"]) answers.get(name)?.();
  await Promise.all([...first, old, newest]);
});
