import { findTables, parseTsv } from "./markdown-table";

type HtmlClipboard = typeof import("./clipboard-html");
let parser: HtmlClipboard | undefined;
let loading: Promise<void> | undefined;
export const htmlClipboardReady = () => parser !== undefined;
export const loadHtmlClipboard = (): Promise<void> =>
  (loading ??= import("./clipboard-html").then(
    (module) => {
      parser = module;
    },
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  ));
const loaded = (): HtmlClipboard => {
  if (!parser) throw new Error("HTML clipboard parser is not loaded");
  return parser;
};
export const parseClipboardHtml = (html: string) => loaded().parseClipboardHtml(html);
export const convertClipboardHtml = (html: string, code: boolean) => loaded().convertHtml(html, code);

/** All clipboard entry paths share one preflight, before insertion or conversion. */
export function inspectClipboard(
  data: DataTransfer,
  limits: { maxLength: number; maxPasteCells: number },
): { error: "textTooLarge" | "pasteTooLarge" } | { text: string; html: string; images: number; files: File[]; tsv: string[][] | null } {
  const text = data.getData("text/plain");
  const html = data.getData("text/html");
  if (text.length > limits.maxLength || html.length > limits.maxLength) return { error: "textTooLarge" } as const;
  const tsv = parseTsv(text);
  let cells = tsv ? tsv.length * tsv.reduce((width, row) => Math.max(width, row.length), 0) : 0;
  for (const table of findTables(text))
    cells += (table.lines.length - 1) * table.lines.reduce((width, row) => Math.max(width, row.cells.length), 0);
  const files = Array.from(data.files).filter((file) => file.type.startsWith("image/"));
  let images = files.length;
  if (html) {
    const dom = parseClipboardHtml(html);
    images = Math.max(images, dom.querySelectorAll("img").length);
    let htmlCells = 0;
    for (const table of dom.querySelectorAll("table")) {
      const rows = [...table.querySelectorAll("tr")];
      htmlCells += rows.length * rows.reduce((width, row) => Math.max(width, row.querySelectorAll("td,th").length), 0);
    }
    cells = Math.max(cells, htmlCells);
  }
  if (cells > limits.maxPasteCells) return { error: "pasteTooLarge" } as const;
  return { text, html, images, files, tsv };
}
