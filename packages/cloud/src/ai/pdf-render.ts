import { fileURLToPath } from "node:url";
import { z } from "zod";

declare const __CLOUD_PDF_RENDER_WORKER__: string | undefined;
let activeRenders = 0;
export const PDF_MAX_BYTES = 10 * 1024 * 1024;
export const PdfPages = z
  .array(z.number().int().positive())
  .min(1)
  .max(3)
  .refine((pages) => new Set(pages).size === pages.length, "Choose each page only once.");
const RenderResult = z.object({
  totalPages: z.number().int().positive(),
  pages: z
    .array(z.object({ page: z.number().int().positive(), png: z.string() }))
    .min(1)
    .max(3),
});

/** Isolate native decoding from the server: abort/deadline kills the process. */
export async function renderPdfPages(bytes: Uint8Array, pages: number[] = [1], signal?: AbortSignal) {
  PdfPages.parse(pages);
  if (bytes.byteLength > PDF_MAX_BYTES) throw new Error("PDF exceeds the 10 MiB view_image limit.");
  if (process.platform !== "linux") throw new Error("PDF page inspection requires the Linux Cloud runtime with memory isolation.");
  const boundedSignal = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
  boundedSignal.throwIfAborted();
  if (activeRenders >= 2) throw new Error("PDF rendering is busy. Retry after the current inspection finishes.");
  activeRenders++;
  try {
    const worker =
      typeof __CLOUD_PDF_RENDER_WORKER__ === "string"
        ? new URL(__CLOUD_PDF_RENDER_WORKER__, import.meta.url)
        : new URL("./pdf-render-worker.ts", import.meta.url);
    // RLIMIT_DATA bounds the decoder heap/native writable mappings on Linux.
    // Positional arguments keep paths out of shell code. No elevated privileges.
    const child = Bun.spawn(
      ["/bin/sh", "-c", 'ulimit -d 524288 || exit 70; exec "$@"', "pdf-decoder", process.execPath, "--no-env-file", fileURLToPath(worker)],
      {
        stdin: new Blob([JSON.stringify({ pdf: Buffer.from(bytes).toString("base64"), pages })]),
        stdout: "pipe",
        stderr: "ignore",
        // The decoder needs no application credentials or runtime configuration.
        env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
      },
    );
    const stop = () => child.kill("SIGKILL");
    boundedSignal.addEventListener("abort", stop, { once: true });
    if (boundedSignal.aborted) stop();
    try {
      let length = 0;
      const stdout = child.stdout.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            length += chunk.byteLength;
            // Base64 overhead plus a small JSON envelope over the aggregate PNG budget.
            if (length > Math.ceil((PDF_MAX_BYTES * 4) / 3) + 4096) throw new Error("Rendered PDF exceeds the 10 MiB image budget.");
            controller.enqueue(chunk);
          },
        }),
      );
      const text = await new Response(stdout).text();
      boundedSignal.throwIfAborted();
      if (!text.trim()) throw new Error("PDF decoder failed or exceeded its memory budget.");
      const output: unknown = JSON.parse(text);
      const failure = z.object({ error: z.string().max(500) }).safeParse(output);
      if (failure.success) throw new Error(failure.data.error);
      if ((await child.exited) !== 0) throw new Error("PDF rendering failed.");
      return RenderResult.parse(output);
    } finally {
      boundedSignal.removeEventListener("abort", stop);
      stop();
      await child.exited;
    }
  } finally {
    activeRenders--;
  }
}
