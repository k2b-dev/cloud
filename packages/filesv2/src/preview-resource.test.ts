import { expect, test } from "bun:test";
import { boundedPreviewBody, createPreviewResources, PREVIEW_LIMITS } from "./preview-resource";

const identity = {
  serverUrl: "https://filegate",
  root: "cloud",
  bindingId: "binding",
  basePath: "home/a",
  path: "home/a/file.pdf",
  modified: "2026-09-19",
  size: 3,
  converterUrl: "https://office",
};
const response = (value = "png") => new Response(value);

test("preview bounds unknown-length and dishonest bodies", async () => {
  await expect(boundedPreviewBody(response("12345"), 4, new AbortController().signal)).rejects.toMatchObject({ code: "preview_too_large" });
  await expect(
    boundedPreviewBody(new Response("123", { headers: { "content-length": "2" } }), 4, new AbortController().signal),
  ).rejects.toMatchObject({ code: "unavailable" });
});

test("preview cancels a hanging response at the total deadline", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  await expect(boundedPreviewBody(new Response(stream), 10, AbortSignal.timeout(10))).rejects.toBeDefined();
  expect(cancelled).toBe(true);
});

test("preview deduplicates in-flight work, expires cached values, and keys backing storage", async () => {
  let time = 0,
    reads = 0;
  const run = createPreviewResources({ ...PREVIEW_LIMITS, ttlMs: 10 }, () => time);
  const source = async () => {
    reads++;
    return response("pdf");
  };
  const convert = async () => response();
  await Promise.all([run({ identity, source, convert }), run({ identity, source, convert })]);
  expect(reads).toBe(1);
  await run({ identity, source, convert });
  expect(reads).toBe(1);
  time = 11;
  await run({ identity, source, convert });
  await run({ identity: { ...identity, bindingId: "new-binding" }, source, convert });
  await run({ identity: { ...identity, serverUrl: "https://other" }, source, convert });
  expect(reads).toBe(4);
});

test("preview applies byte LRU budget and never caches failed output", async () => {
  let reads = 0;
  const run = createPreviewResources({ ...PREVIEW_LIMITS, cacheBytes: 5, outputBytes: 4 });
  const source = async () => {
    reads++;
    return response("pdf");
  };
  const convert = async () => response();
  await run({ identity, source, convert });
  await run({ identity: { ...identity, path: "other" }, source, convert });
  await run({ identity, source, convert });
  expect(reads).toBe(3);
  await expect(run({ identity: { ...identity, path: "huge" }, source, convert: async () => response("12345") })).rejects.toMatchObject({
    code: "preview_too_large",
  });
  await run({ identity: { ...identity, path: "huge" }, source, convert });
  expect(reads).toBe(5);
});

test("preview rejects overload without queueing, releases capacity after synchronous failure", async () => {
  const run = createPreviewResources({ ...PREVIEW_LIMITS, concurrency: 1 });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const active = run({
    identity,
    source: async () => {
      await hold;
      return response();
    },
    convert: async () => response(),
  });
  await expect(
    run({ identity: { ...identity, path: "second" }, source: async () => response(), convert: async () => response() }),
  ).rejects.toMatchObject({ code: "unavailable" });
  release();
  await active;
  const changed = { ...identity, path: "throw" };
  await expect(
    run({
      identity: changed,
      source: () => {
        throw new Error("failed");
      },
      convert: async () => response(),
    }),
  ).rejects.toThrow("failed");
  await expect(run({ identity: changed, source: async () => response(), convert: async () => response() })).resolves.toBeInstanceOf(
    ArrayBuffer,
  );
});
