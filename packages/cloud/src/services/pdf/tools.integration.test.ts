import { beforeAll, expect, test } from "bun:test";
import { extractZip } from "@k2b/stdlib/browser";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { requireInfraUrl, suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { type GotenbergConfig, renderHtmlToPdfWithConfig } from "./gotenberg";
import { runPdfToolWithConfig } from "./tools";

async function inspect(data: Uint8Array) {
  const task = getDocument({ data: data.slice() });
  try {
    const document = await task.promise;
    const pages: { text: string; rotate: number }[] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      pages.push({
        text: (await page.getTextContent()).items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .trim(),
        rotate: page.rotate,
      });
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

suiteFor("gotenberg", "valkey")("PDF tools with the operator renderer", () => {
  let config: GotenbergConfig;
  let file: Blob;
  beforeAll(async () => {
    config = { url: requireInfraUrl("gotenberg"), timeoutMs: 30_000, maxHtmlBytes: 1024 * 1024, maxPdfBytes: 10 * 1024 * 1024 };
    const { pdf } = await renderHtmlToPdfWithConfig(
      {
        html: "<!doctype html><style>@page{size:A4}section{break-after:page}section:last-child{break-after:auto}</style><section>PAGE-ONE</section><section>PAGE-TWO</section><section>PAGE-THREE</section>",
      },
      config,
    );
    file = new Blob([new Uint8Array(pdf)], { type: "application/pdf" });
    expect((await inspect(pdf)).map((page) => page.text)).toEqual(["PAGE-ONE", "PAGE-TWO", "PAGE-THREE"]);
  });
  test("reorder and merge preserve actual PDF page text order", async () => {
    const reordered = await runPdfToolWithConfig({ files: [file], operation: { kind: "reorder", pages: [3, 1, 2] } }, config);
    expect((await inspect(reordered.data)).map((page) => page.text)).toEqual(["PAGE-THREE", "PAGE-ONE", "PAGE-TWO"]);
    const extracted = await runPdfToolWithConfig({ files: [file], operation: { kind: "extract", pages: [2] } }, config);
    const merged = await runPdfToolWithConfig(
      { files: [new Blob([new Uint8Array(extracted.data)], { type: "application/pdf" }), file], operation: { kind: "merge" } },
      config,
    );
    expect((await inspect(merged.data)).map((page) => page.text)).toEqual(["PAGE-TWO", "PAGE-ONE", "PAGE-TWO", "PAGE-THREE"]);
  }, 120_000);
  test("rotation affects exactly the selected pages", async () => {
    const rotated = await runPdfToolWithConfig({ files: [file], operation: { kind: "rotate", pages: [2], angle: 90 } }, config);
    const pages = await inspect(rotated.data);
    expect(pages.map((page) => page.rotate)).toEqual([0, 90, 0]);
    expect(pages.map((page) => page.text)).toEqual(["PAGE-ONE", "PAGE-TWO", "PAGE-THREE"]);
  }, 60_000);
  test("split ZIP contains every requested group in its declared order", async () => {
    const split = await runPdfToolWithConfig({ files: [file], operation: { kind: "split", groups: [[3], [1, 2]] } }, config);
    const parts = await extractZip(split.data, { maxEntries: 2, maxBytes: config.maxPdfBytes });
    expect(parts.map((part) => part.filename)).toEqual(["part-000001.pdf", "part-000002.pdf"]);
    expect((await inspect(parts[0]!.data)).map((page) => page.text)).toEqual(["PAGE-THREE"]);
    expect((await inspect(parts[1]!.data)).map((page) => page.text)).toEqual(["PAGE-ONE", "PAGE-TWO"]);
  }, 60_000);
});
