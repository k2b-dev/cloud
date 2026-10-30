import { resolve } from "node:path";
import fontPath from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2" with { type: "file" };
import { charts } from "@k2b/stdlib";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { deriveMeta } from "../shared/metadata";
import { NotesError } from "./errors";
import { hash } from "./tokens";

// Metadata is a bounded excerpt; full note content never enters XML or the rasterizer.
export const previewMeta = (content: string) => deriveMeta(content.slice(0, 65_536));
const escape = (value: string) =>
  value
    .toWellFormed()
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, " ")
    .replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export const linkMetadata = (html: string, token: string, readId: string, origin: string, content: string): string => {
  const meta = previewMeta(content);
  const title = meta.title.slice(0, 200) || "k2b notes";
  const description = meta.excerpt.slice(0, 240);
  const tags = `<title>${escape(title)}</title>\n<meta property="og:type" content="article">\n<meta property="og:title" content="${escape(title)}">\n<meta property="og:description" content="${escape(description)}">\n<meta property="og:url" content="${escape(`${origin}/p/${token}`)}">\n<meta property="og:image" content="${escape(`${origin}/p/${readId}/preview.png`)}">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">`;
  const withoutTitle = html.replace(/<title>[^<]*<\/title>/i, "");
  return withoutTitle.includes("<!--og-->")
    ? withoutTitle.replace("<!--og-->", () => tags)
    : withoutTitle.replace("</head>", () => `${tags}\n</head>`);
};
const lines = (value: string, characters: number, maximum: number): string[] => {
  const words = Array.from(value.replace(/\s+/g, " ").trim());
  const output: string[] = [];
  while (words.length && output.length < maximum) output.push(words.splice(0, characters).join(""));
  if (words.length && output.length) output[output.length - 1] = output.at(-1)!.slice(0, -1) + "…";
  return output;
};
let fontReady = false;
/** All inputs are text and finite local numbers. No URL, HTML, SVG or image from a note enters the renderer. */
export const renderPreview = async (content: string): Promise<Uint8Array> => {
  if (!fontReady) {
    if (!GlobalFonts.registerFromPath(resolve(import.meta.dir, fontPath), "Notes Preview")) throw new Error("preview_font_failed");
    fontReady = true;
  }
  const meta = previewMeta(content);
  const title = lines(meta.title || "k2b notes", meta.chart ? 24 : 42, 3);
  const excerpt = lines(meta.excerpt, meta.chart ? 38 : 72, 4);
  let diagram = "";
  if (meta.chart) {
    const values = meta.chart.values.filter(Number.isFinite).slice(0, 100);
    const options = { width: 470, height: 310 };
    diagram =
      meta.chart.kind === "line"
        ? charts.line({ ...options, series: [{ data: values.map((y, x) => ({ x, y })) }], smooth: false })
        : charts.bar({ ...options, data: values.map((value, index) => ({ label: String(index + 1), value })) });
    // SVG rasterizers do not all implement CSS custom properties. Only generated palette references are replaced.
    const palette = ["#6d28d9", "#047857", "#b45309", "#be123c", "#2563eb", "#a21caf", "#0f766e", "#c2410c"];
    diagram = diagram.replace(/var\(--stdlib-chart-c([1-8])\)/g, (_whole, index: string) => palette[Number(index) - 1]!);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#ffffff"/><rect x="56" y="62" width="7" height="42" rx="3" fill="#6d28d9"/><g font-family="Notes Preview, sans-serif" fill="#11151b"><text x="82" y="94" font-size="27">k2b notes</text>${title.map((line, index) => `<text x="64" y="${184 + index * 58}" font-size="48" font-weight="400">${escape(line)}</text>`).join("")}${excerpt.map((line, index) => `<text x="64" y="${Math.max(340, 206 + title.length * 58) + index * 32}" font-size="24" fill="#45454e">${escape(line)}</text>`).join("")}<text x="64" y="574" font-size="20" fill="#45454e">Notizen · lokal &amp; gemeinsam</text></g>${diagram ? `<g transform="translate(666,180)" font-family="Notes Preview, sans-serif">${diagram}</g>` : ""}</svg>`;
  const canvas = createCanvas(1200, 630);
  const image = await loadImage(Buffer.from(svg));
  canvas.getContext("2d").drawImage(image, 0, 0);
  return canvas.encode("png");
};

export class Previews {
  private active = false;
  private readonly cache = new Map<string, { fingerprint: string; png: Uint8Array }>();
  private pending?: { readId: string; fingerprint: string; result: Promise<Uint8Array> };
  constructor(private readonly capacity: number) {}
  async get(readId: string, content: string): Promise<Uint8Array> {
    const fingerprint = hash(content);
    const cached = this.cache.get(readId);
    if (cached?.fingerprint === fingerprint) {
      this.cache.delete(readId);
      this.cache.set(readId, cached);
      return cached.png;
    }
    if (this.pending?.readId === readId && this.pending.fingerprint === fingerprint) return this.pending.result;
    if (this.active) throw new NotesError("preview_busy", 503);
    this.active = true;
    const result = renderPreview(content)
      .then((png) => {
        this.cache.delete(readId);
        this.cache.set(readId, { fingerprint, png });
        while (this.cache.size > this.capacity) this.cache.delete(this.cache.keys().next().value!);
        return png;
      })
      .finally(() => {
        this.active = false;
        this.pending = undefined;
      });
    this.pending = { readId, fingerprint, result };
    return result;
  }
}
