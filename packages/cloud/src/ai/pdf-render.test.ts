import { expect, spyOn, test } from "bun:test";
import { z } from "zod";
import * as canvasWorker from "../_internal/canvas-worker";
import { PDF_MAX_BYTES, PdfPages, renderPdfPages } from "./pdf-render";
import { visionPdfFixture } from "./pdf-render.fixture";

const originalSpawn = canvasWorker.spawnCanvasWorker;

test.skipIf(process.platform !== "linux")("PDF renderer selects one-based pages in requested order and emits bounded PNGs", async () => {
  const result = await renderPdfPages(visionPdfFixture(), [2, 1]);
  expect(result.totalPages).toBe(2);
  expect(result.pages.map((page) => page.page)).toEqual([2, 1]);
  for (const page of result.pages) {
    const png = Buffer.from(page.png, "base64");
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBe(600);
    expect(png.readUInt32BE(20)).toBe(400);
  }
  expect(result.pages[0]!.png).not.toBe(result.pages[1]!.png);
});

test.skipIf(process.platform !== "linux")("PDF renderer rejects invalid selection, oversized inputs and damaged documents", async () => {
  for (const pages of [[], [0], [1, 1], Array.from({ length: 21 }, (_, index) => index + 1)])
    expect(PdfPages.safeParse(pages).success).toBe(false);
  await expect(renderPdfPages(new Uint8Array(PDF_MAX_BYTES + 1))).rejects.toThrow("10 MiB");
  await expect(renderPdfPages(new TextEncoder().encode("not a PDF"))).rejects.toThrow("invalid or damaged");
  await expect(renderPdfPages(visionPdfFixture(), [3])).rejects.toThrow("PDF has 2 pages");
  const encrypted = new Uint8Array(await Bun.file(new URL("./fixtures/vision-encrypted.pdf", import.meta.url)).arrayBuffer());
  await expect(renderPdfPages(encrypted)).rejects.toThrow("Password-protected PDFs");
});

test.skipIf(process.platform !== "linux")("PDF rendering cancellation terminates the decoder and the next render still works", async () => {
  const controller = new AbortController();
  const pending = renderPdfPages(visionPdfFixture(), [1], controller.signal);
  controller.abort();
  await expect(pending).rejects.toBeInstanceOf(Error);
  expect((await renderPdfPages(visionPdfFixture())).pages.map((page) => page.page)).toEqual([1, 2]);
});

test.skipIf(process.platform !== "linux")(
  "previews explicitly accept PDF inputs beyond the AI limit while keeping the default unchanged",
  async () => {
    const bytes = new Uint8Array(PDF_MAX_BYTES + 1);
    bytes.fill(32);
    bytes.set(visionPdfFixture());
    await expect(renderPdfPages(bytes)).rejects.toThrow("10 MiB");
    expect((await renderPdfPages(bytes, [1], undefined, { maxInputBytes: 50_000_000 })).pages).toHaveLength(1);
    await expect(renderPdfPages(new Uint8Array(), [1], undefined, { maxInputBytes: 50_000_001 })).rejects.toThrow(RangeError);
  },
  30_000,
);

test.skipIf(process.platform !== "linux")("PDF decoder keeps a fixed thread set so its memory limit holds on any core count", async () => {
  // The data limit also counts per-thread memory: pools sized by core count exhausted it on 16-core hosts.
  // The probe runs the real decoder with the real spawn settings and reports its threads after the render and a full GC,
  // because a pool that starts on demand (the GC helpers) is not yet running when sampled from outside.
  const spawn = spyOn(canvasWorker, "spawnCanvasWorker").mockImplementationOnce((worker, name, input, cpuSeconds) => {
    expect(worker.href).toBe(new URL("./pdf-render-worker.ts", import.meta.url).href);
    return originalSpawn(new URL("./fixtures/pdf-decoder-thread-probe.test-fixture.ts", import.meta.url), name, input, cpuSeconds);
  });
  try {
    expect((await renderPdfPages(visionPdfFixture())).pages).toHaveLength(2);
    const spawned = spawn.mock.results[0];
    if (spawned?.type !== "return") throw new Error("The PDF decoder did not start.");
    const report = (await spawned.value.diagnostics).split("\n").findLast((line) => line.startsWith("thread-counts "));
    if (!report) throw new Error("The probe reported no thread counts.");
    const threads = z.record(z.string(), z.number()).parse(JSON.parse(report.slice("thread-counts ".length)));
    // Each pool must be seen, so a renamed thread fails here instead of passing unchecked.
    expect(threads["tokio-rt-worker"]).toBeGreaterThan(0);
    expect(threads["tokio-rt-worker"]).toBeLessThanOrEqual(2);
    expect(threads["Bun Pool"]).toBeGreaterThan(0);
    expect(threads["Bun Pool"]).toBeLessThanOrEqual(2);
    // Two GC markers are the collector plus one helper; without the setting JSC starts one per core, up to seven.
    expect(threads.HeapHelper).toBe(1);
  } finally {
    spawn.mockRestore();
  }
});
