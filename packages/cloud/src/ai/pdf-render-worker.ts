// Standalone subprocess. No server imports or application credentials.

import { readSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { z } from "zod";

const MAX_BYTES = 10 * 1024 * 1024;
const inputSchema = z.object({
  bytes: z.number().int().nonnegative().max(50_000_000),
  maxInputBytes: z.number().int().min(1).max(50_000_000).default(MAX_BYTES),
  pages: z.array(z.number().int().positive()).min(1).max(3),
});
const require = createRequire(import.meta.url);
const root = dirname(require.resolve("pdfjs-dist/package.json"));
try {
  // A binary frame avoids base64 and JSON copies of a 50 MB document inside the 512 MiB worker.
  const header = new Uint8Array(4096);
  let used = 0;
  let newline = -1;
  while (newline < 0) {
    const read = readSync(0, header, used, header.length - used, null);
    if (!read) throw new Error("Missing PDF frame header.");
    used += read;
    newline = header.subarray(0, used).indexOf(10);
    if (newline < 0 && used === header.length) throw new Error("PDF frame header exceeds 4 KiB.");
  }
  const input = inputSchema.parse(JSON.parse(new TextDecoder().decode(header.subarray(0, newline))));
  const data = new Uint8Array(input.bytes);
  let filled = used - newline - 1;
  if (filled > data.length) throw new Error("PDF frame exceeds declared length.");
  data.set(header.subarray(newline + 1, used));
  while (filled < data.length) {
    const read = readSync(0, data, filled, data.length - filled, null);
    if (!read) throw new Error("Truncated PDF frame.");
    filled += read;
  }
  if (readSync(0, header, 0, 1, null)) throw new Error("PDF frame exceeds declared length.");
  if (data.byteLength > input.maxInputBytes) throw new Error("PDF exceeds the input limit.");
  const task = getDocument({
    data,
    verbosity: 0,
    cMapUrl: join(root, "cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: join(root, "standard_fonts/"),
    wasmUrl: join(root, "wasm/"),
    useSystemFonts: false,
    stopAtErrors: true,
    // Bound decoded source-image allocations as well as the output canvas.
    maxImageSize: 16 * 1024 * 1024,
  });
  try {
    const document = await task.promise;
    if (input.pages.some((page) => page > document.numPages))
      throw new Error(`PDF has ${document.numPages} pages. Choose pages within that range.`);
    const pages: { page: number; png: string }[] = [];
    let outputBytes = 0;
    for (const number of input.pages) {
      const page = await document.getPage(number);
      const original = page.getViewport({ scale: 1 });
      if (!(original.width > 0 && original.height > 0 && Number.isFinite(original.width + original.height)))
        throw new Error("PDF page dimensions are invalid.");
      const viewport = page.getViewport({ scale: Math.min(2, 2000 / Math.max(original.width, original.height)) });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      try {
        // PDF.js uses the Canvas API implemented by the native canvas; its types
        // describe browser HTMLCanvasElement rather than the supported Node canvas.
        await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
        const png: Uint8Array = canvas.toBuffer("image/png");
        outputBytes += png.byteLength;
        if (outputBytes > MAX_BYTES) throw new Error("Rendered PDF exceeds the 10 MiB image budget.");
        pages.push({ page: number, png: Buffer.from(png).toString("base64") });
      } finally {
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();
      }
    }
    process.stdout.write(JSON.stringify({ totalPages: document.numPages, pages }));
  } finally {
    await task.destroy();
  }
} catch (error) {
  const name = error instanceof Error ? error.name : "";
  const message =
    name === "PasswordException"
      ? "Password-protected PDFs are not supported. Provide an unlocked copy."
      : name === "InvalidPDFException"
        ? "The PDF is invalid or damaged."
        : error instanceof Error
          ? error.message.slice(0, 500)
          : "PDF rendering failed.";
  process.stdout.write(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
