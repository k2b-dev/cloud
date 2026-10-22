/**
 * What a rendered PDF shows to viewers, copy, and search, read with Poppler.
 * CI installs Poppler next to Gotenberg; a missing tool fails loudly instead
 * of letting a check pass vacuously.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

type PopplerTool = "pdfinfo" | "pdftotext" | "pdffonts" | "pdfimages";

/** Output of a Poppler tool for a PDF. The tool path can be overridden with `PDFINFO`, `PDFTOTEXT`, `PDFFONTS`, or `PDFIMAGES`. */
const poppler = async (tool: PopplerTool, pdf: Uint8Array, args: string[]): Promise<string> => {
  const binary = Bun.which(process.env[tool.toUpperCase()] ?? tool);
  if (!binary) throw new Error(`Poppler's ${tool} is not on PATH; install Poppler or set ${tool.toUpperCase()}.`);
  const directory = await mkdtemp(join(tmpdir(), "cloud-pdf-info-"));
  try {
    const path = join(directory, "document.pdf");
    await Bun.write(path, pdf);
    const run = Bun.spawn([binary, ...args, path, ...(tool === "pdftotext" ? ["-"] : [])], { stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
    if (code !== 0) throw new Error(`${tool} failed: ${error}`);
    return output;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

/** The Info dictionary title that PDF viewers show in their window or tab. */
export const pdfTitle = async (pdf: Uint8Array): Promise<string | null> =>
  /^Title:[ \t]*(.*)$/m.exec(await poppler("pdfinfo", pdf, ["-enc", "UTF-8"]))?.[1] ?? null;

/** The text layer of a PDF: what copy and search see. */
export const pdfText = (pdf: Uint8Array, options: { layout?: boolean } = {}): Promise<string> =>
  poppler("pdftotext", pdf, ["-enc", "UTF-8", ...(options.layout ? ["-layout"] : [])]);

/** Fonts that draw the PDF, without subset prefixes, and whether each is embedded, subset, and mapped to Unicode. */
export const pdfFonts = async (pdf: Uint8Array) =>
  (await poppler("pdffonts", pdf, []))
    .split("\n")
    .slice(2)
    .filter((line) => line.trim())
    .map((line) => {
      const fields = line.trim().split(/\s+/);
      const [emb, sub, uni] = fields.slice(-5, -2);
      return { name: fields[0]!.replace(/^[A-Z]{6}\+/, ""), embedded: emb === "yes", subset: sub === "yes", unicode: uni === "yes" };
    });

/**
 * Letters that Chromium drew as one ligature glyph, such as `ffi`. It marks
 * each ligature glyph with its letters as `ActualText`, which copy and search use.
 */
export const pdfLigatures = (pdf: Uint8Array): string[] => {
  const raw = Buffer.from(pdf).toString("latin1");
  return [...raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)].flatMap(([, data = ""]) => {
    let content = data;
    try {
      content = inflateSync(Buffer.from(data, "latin1")).toString("latin1");
    } catch {
      // Not Flate-compressed: search the stream as stored.
    }
    return [...content.matchAll(/\/ActualText \(([^)]*)\)/g)].map(([, letters = ""]) => letters);
  });
};

/** Distinct raster image objects, including alpha masks; repeated placements keep their first page. */
export const pdfImages = async (
  pdf: Uint8Array,
): Promise<
  Array<{
    page: number;
    type: "image" | "smask";
    width: number;
    height: number;
    color: string;
    comp: number;
    bpc: number;
    enc: string;
  }>
> => {
  const seen = new Set<string>();
  return (await poppler("pdfimages", pdf, ["-list"]))
    .split("\n")
    .slice(2)
    .flatMap((line) => {
      const fields = line.trim().split(/\s+/);
      const type = fields[2];
      if (type !== "image" && type !== "smask") return [];
      // Poppler lists every drawing of an XObject. Image and smask may share its object ID.
      const key =
        /^\d+$/.test(fields[10] ?? "") && /^\d+$/.test(fields[11] ?? "")
          ? `${type}:${fields[10]}:${fields[11]}`
          : `${type}:inline:${fields[0]}:${fields[1]}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          page: Number(fields[0]),
          type,
          width: Number(fields[3]),
          height: Number(fields[4]),
          color: fields[5]!,
          comp: Number(fields[6]),
          bpc: Number(fields[7]),
          enc: fields[8]!,
        },
      ];
    });
};
