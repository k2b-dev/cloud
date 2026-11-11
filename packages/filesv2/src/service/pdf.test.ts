import { expect, mock, test } from "bun:test";
import { type GotenbergConfig, GotenbergRenderError } from "@k2b/cloud/services/pdf";
import { testActor, testCall } from "../../test/files-call";
import type { EntryResult } from "../contracts";
import type { PdfEvent, PdfInput } from "../pdf-contracts";
import { FilesError } from "./errors";
import { createPdfOperation, pdfError } from "./pdf";

const config: GotenbergConfig = { url: "http://renderer.invalid", timeoutMs: 10_000, maxPdfBytes: 1024, maxHtmlBytes: 1024 * 1024 };
const call = testCall(testActor);
const result: EntryResult = {
  base: {
    id: "base",
    area: "cloud",
    kind: "users",
    name: "Alice",
    status: "existing",
    reason: null,
    indexEnabled: true,
    versioningEnabled: true,
  },
  entry: {
    path: "folder/result (1).pdf",
    name: "result (1).pdf",
    directory: false,
    size: 10,
    modified: "2026-01-01T00:00:00Z",
    revision: "revision",
  },
};
const input: PdfInput = { operation: "merge", paths: ["folder/b.pdf", "a.pdf"], name: "result.pdf" };
function fixture(options: { sizes?: number[]; content?: string; denied?: boolean } = {}) {
  const reads: string[] = [];
  const stats: string[] = [];
  const save = mock<Parameters<typeof createPdfOperation>[0]["save"]>(async (_call, _baseId, _path, _bytes, signal) => {
    signal.throwIfAborted();
    return result;
  });
  const run = mock<NonNullable<Parameters<typeof createPdfOperation>[0]["run"]>>(async (input, _config, options) => {
    options?.signal?.throwIfAborted();
    expect(await Promise.all(input.files.map((file) => file.text()))).toEqual(["%PDF-folder/b.pdf", "%PDF-a.pdf"]);
    if (input.operation.kind === "extract" && input.files.length > 1) await options?.onOperation?.();
    await options?.onOperation?.();
    return { data: new TextEncoder().encode("%PDF-result"), contentType: "application/pdf", extension: "pdf" };
  });
  const prepare = createPdfOperation({
    config: async () => config,
    source: async (_call, _baseId, path) => {
      const index = stats.push(path) - 1;
      return {
        size: options.sizes?.[index] ?? 20,
        read: async (signal) => {
          signal.throwIfAborted();
          reads.push(path);
          return new Response(options.content ?? `%PDF-${path}`);
        },
      };
    },
    destination: async () => {
      if (options.denied) throw new FilesError("forbidden", 403);
    },
    save,
    run,
  });
  return { prepare, reads, stats, run, save };
}

test("merge preserves source order, saves next to first source and reports every step", async () => {
  const f = fixture();
  const prepared = await f.prepare(call, "base", input, AbortSignal.timeout(1000));
  expect(f.reads).toEqual([]);
  expect(f.stats).toEqual(input.paths);
  const events: PdfEvent[] = [];
  await prepared.run(async (event) => {
    events.push(event);
  }, AbortSignal.timeout(1000));
  expect(f.reads).toEqual(input.paths);
  expect(f.save.mock.calls[0]?.slice(1, 3)).toEqual(["base", "folder/result.pdf"]);
  expect(events).toEqual([...[0, 1, 2, 3, 4].map((done): PdfEvent => ({ type: "progress", done, total: 4 })), { type: "done", result }]);
});

test("multi-source extraction forwards concatenated page indices and counts merge plus extraction", async () => {
  const f = fixture();
  const prepared = await f.prepare(call, "base", { ...input, operation: "extract", pages: [2, 4] }, AbortSignal.timeout(1000));
  const events: PdfEvent[] = [];
  await prepared.run(async (event) => {
    events.push(event);
  }, AbortSignal.timeout(1000));
  expect(f.run.mock.calls[0]?.[0].operation).toEqual({ kind: "extract", pages: [2, 4] });
  expect(events.filter((event) => event.type === "progress").map((event) => event.done)).toEqual([0, 1, 2, 3, 4, 5]);
});

test("stat sizes refuse oversized input before any source bytes or renderer work", async () => {
  const f = fixture({ sizes: [600, 600] });
  await expect(f.prepare(call, "base", input, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: "pdf_too_large" });
  expect(f.reads).toEqual([]);
  expect(f.run).not.toHaveBeenCalled();
});

test("destination access is checked before reading sources", async () => {
  const f = fixture({ denied: true });
  await expect(f.prepare(call, "base", input, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: "forbidden" });
  expect(f.stats).toEqual([]);
  expect(f.reads).toEqual([]);
});

test("a denied later source prevents every byte read", async () => {
  const read = mock(async () => new Response("%PDF-source"));
  const prepare = createPdfOperation({
    config: async () => config,
    destination: async () => {},
    source: async (_call, _base, path) => {
      if (path === "a.pdf") throw new FilesError("forbidden", 403);
      return { size: 20, read };
    },
    save: async () => result,
  });
  await expect(prepare(call, "base", input, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: "forbidden" });
  expect(read).not.toHaveBeenCalled();
});

test("renderer availability and configured count/page limits fail before source stats", async () => {
  for (const [configuration, operation] of [
    [{ ...config, url: "" }, input],
    [config, { ...input, paths: Array.from({ length: 100 }, () => "a.pdf") }],
    [config, { ...input, operation: "extract", pages: [99] }],
  ] as const) {
    const source = mock(async () => ({ size: 20, read: async () => new Response("%PDF-source") }));
    const prepare = createPdfOperation({
      config: async () => configuration,
      source,
      destination: async () => {},
      save: async () => result,
    });
    await expect(prepare(call, "base", operation, AbortSignal.timeout(1000))).rejects.toBeInstanceOf(FilesError);
    expect(source).not.toHaveBeenCalled();
  }
});

test("names, file counts, source extensions, pages and order are validated", async () => {
  for (const raw of [
    { ...input, paths: ["a.pdf"] },
    { ...input, name: "../out.pdf" },
    { ...input, name: "a.txt" },
    { ...input, paths: ["../a.pdf", "b.pdf"] },
    { ...input, paths: ["a.txt", "b.pdf"] },
    { ...input, operation: "extract", pages: [2, 1] },
    { ...input, operation: "extract", pages: [1, 1] },
    { ...input, operation: "extract", pages: [0] },
    { ...input, operation: "extract", pages: [1.5] },
  ]) {
    const f = fixture();
    await expect(f.prepare(call, "base", raw, AbortSignal.timeout(1000))).rejects.toBeInstanceOf(FilesError);
    expect(f.reads).toEqual([]);
  }
});

test("signature mismatch attributes unreadable PDF to the source and never saves", async () => {
  const f = fixture({ content: "not a PDF" });
  const prepared = await f.prepare(call, "base", input, AbortSignal.timeout(1000));
  await expect(prepared.run(async () => {}, AbortSignal.timeout(1000))).rejects.toMatchObject({
    code: "pdf_unreadable",
    path: input.paths[0],
  });
  expect(f.save).not.toHaveBeenCalled();
});

test("request cancellation stops a blocked source read and prevents saving", async () => {
  const controller = new AbortController();
  let sourceCancelled = false;
  let reading: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const save = mock(async () => result);
  const prepare = createPdfOperation({
    config: async () => config,
    source: async () => ({
      size: 10,
      read: async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("%PDF-"));
              reading();
            },
            cancel() {
              sourceCancelled = true;
            },
          }),
        ),
    }),
    destination: async () => {},
    save,
  });
  const prepared = await prepare(call, "base", input, controller.signal);
  const running = prepared.run(async () => {}, new AbortController().signal);
  await entered;
  controller.abort();
  await expect(running).rejects.toBeInstanceOf(DOMException);
  expect(sourceCancelled).toBe(true);
  expect(save).not.toHaveBeenCalled();
});

test("cancellation immediately before saving prevents publication", async () => {
  const f = fixture();
  const controller = new AbortController();
  const prepared = await f.prepare(call, "base", input, controller.signal);
  await expect(
    prepared.run(async (event) => {
      if (event.type === "progress" && event.done === 3) controller.abort();
    }, new AbortController().signal),
  ).rejects.toBeInstanceOf(DOMException);
  expect(f.save).not.toHaveBeenCalled();
});

test("renderer errors map to stable Files codes and source paths", () => {
  for (const [from, to] of [
    ["encrypted_pdf", "pdf_encrypted"],
    ["unreadable_pdf", "pdf_unreadable"],
    ["pdf_too_large", "pdf_too_large"],
    ["not_configured", "pdf_not_configured"],
    ["request_failed", "pdf_failed"],
  ] as const) {
    expect(pdfError(new GotenbergRenderError(from, "diagnostic", undefined, 1), input.paths)).toMatchObject({ code: to });
  }
  expect(pdfError(new GotenbergRenderError("encrypted_pdf", "diagnostic", undefined, 1), input.paths)).toMatchObject({ path: "a.pdf" });
  expect(pdfError(new GotenbergRenderError("bad_response", "diagnostic", 422), input.paths)).toMatchObject({
    code: "pdf_unreadable",
    path: undefined,
  });
});
