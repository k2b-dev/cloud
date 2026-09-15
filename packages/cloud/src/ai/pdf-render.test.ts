import { expect, test } from "bun:test";
import { PdfPages, renderPdfPages, PDF_MAX_BYTES } from "./pdf-render";
import { visionPdfFixture } from "./pdf-render.fixture";

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
  for (const pages of [[], [0], [1, 1], [1, 2, 3, 4]]) expect(PdfPages.safeParse(pages).success).toBe(false);
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
  expect((await renderPdfPages(visionPdfFixture())).pages.map((page) => page.page)).toEqual([1]);
});
