/**
 * The document title of a rendered PDF as Poppler's `pdfinfo` reports it:
 * the Info dictionary title that PDF viewers show in their window or tab.
 * CI installs Poppler next to Gotenberg; a missing `pdfinfo` fails loudly
 * instead of letting a metadata check pass vacuously.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const pdfTitle = async (pdf: Uint8Array): Promise<string | null> => {
  const pdfinfo = Bun.which(process.env.PDFINFO ?? "pdfinfo");
  if (!pdfinfo) throw new Error("Poppler's pdfinfo is not on PATH; install Poppler or set PDFINFO.");
  const directory = await mkdtemp(join(tmpdir(), "cloud-pdf-info-"));
  try {
    const path = join(directory, "document.pdf");
    await Bun.write(path, pdf);
    const run = Bun.spawn([pdfinfo, "-enc", "UTF-8", path], { stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
    if (code !== 0) throw new Error(`pdfinfo failed: ${error}`);
    return /^Title:[ \t]*(.*)$/m.exec(output)?.[1] ?? null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
