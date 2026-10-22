import DOMPurify from "dompurify";
import { findTables, parseTsv } from "./markdown-table";

/** Parse only the HTML vocabulary that the Markdown converter consumes.
 * Resource attributes and active elements never reach a clipboard consumer.
 * The returned detached body is read as data and never mounted in the editor.
 */
export const parseClipboardHtml = (html: string): HTMLElement => {
  const body = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "p",
      "div",
      "span",
      "u",
      "font",
      "abbr",
      "acronym",
      "cite",
      "dfn",
      "mark",
      "q",
      "small",
      "sub",
      "sup",
      "big",
      "tt",
      "ins",
      "time",
      "var",
      "samp",
      "kbd",
      "ruby",
      "rt",
      "rp",
      "bdi",
      "bdo",
      "br",
      "b",
      "strong",
      "i",
      "em",
      "s",
      "del",
      "a",
      "code",
      "pre",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "ul",
      "ol",
      "li",
      "blockquote",
      "hr",
      "section",
      "article",
      "table",
      "thead",
      "tbody",
      "tfoot",
      "tr",
      "th",
      "td",
      "img",
    ],
    ALLOWED_ATTR: ["href", "style"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM: true,
  });
  if (!(body instanceof HTMLElement)) throw new TypeError("Clipboard HTML did not produce an HTML element");
  return body;
};

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
