// Standalone subprocess. No server imports or application credentials.
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const MAX_BYTES = 10 * 1024 * 1024;
const inputSchema = z.object({
  pdf: z.string().max(Math.ceil((MAX_BYTES * 4) / 3)),
  pages: z.array(z.number().int().positive()).min(1).max(3),
});
const require = createRequire(import.meta.url);
const root = dirname(require.resolve("pdfjs-dist/package.json"));
try {
  const input = inputSchema.parse(JSON.parse(await Bun.stdin.text()));
  const data = Buffer.from(input.pdf, "base64");
  if (data.byteLength > MAX_BYTES) throw new Error("PDF exceeds the 10 MiB limit.");
  const task = getDocument({
    data: new Uint8Array(data),
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
