import DOMPurify from "dompurify";
import { tableFromGrid } from "./markdown-table";

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

const SAFE_URL = /^(https?:|mailto:)/i;
const preservesWhitespace = (node: HTMLElement) => node.tagName === "PRE" || /^(pre|pre-wrap|break-spaces)$/.test(node.style.whiteSpace);
const isBlock = (node: HTMLElement) =>
  /^(P|DIV|H[1-6]|UL|OL|TABLE|BLOCKQUOTE|PRE|HR|SECTION|ARTICLE)$/.test(node.tagName) || preservesWhitespace(node);

// Editor clipboards use one div per source line. Read the sanitized, detached
// tree without paragraph spacing, Markdown formatting or whitespace folding.
const literalText = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof HTMLElement) || node.tagName === "IMG") return "";
  if (node.tagName === "BR") return "\n";
  if (/^(DIV|P)$/.test(node.tagName) && node.childNodes.length === 1 && node.firstChild?.nodeName === "BR") return "";
  const lines: string[] = [];
  let run: string | null = null;
  for (const child of node.childNodes) {
    if (child instanceof HTMLElement && isBlock(child)) {
      if (run !== null) lines.push(run);
      run = null;
      lines.push(literalText(child));
    } else run = (run ?? "") + literalText(child);
  }
  if (run !== null) lines.push(run);
  return lines.join("\n");
};

const isBold = (el: HTMLElement) => {
  const weight = el.style.fontWeight;
  if (weight === "normal" || weight === "400") return false; // Google Docs wraps everything in <b style="font-weight:normal">
  return el.tagName === "B" || el.tagName === "STRONG" || weight === "bold" || Number(weight) >= 600;
};
const isItalic = (el: HTMLElement) => el.tagName === "I" || el.tagName === "EM" || el.style.fontStyle === "italic";

const surround = (text: string, before: string, after = before): string => {
  const body = text.trim();
  if (!body) return text;
  const from = text.length - text.trimStart().length;
  return text.slice(0, from) + before + body + after + text.slice(from + body.length);
};

const codeFence = (text: string, minimum: number): string => {
  let length = minimum;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  return "`".repeat(length);
};

const inline = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\s+/g, " ");
  if (!(node instanceof HTMLElement)) return "";
  if (node.tagName === "BR") return "\n";
  if (node.tagName === "IMG") return "";
  if (node.tagName === "CODE") {
    const text = node.textContent ?? "";
    if (!text) return "";
    const fence = codeFence(text, 1);
    const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
    return `${fence}${padding}${text}${padding}${fence}`;
  }
  const inner = [...node.childNodes].map(inline).join("");
  if (!inner.trim()) return inner;
  if (node.tagName === "A") {
    const href = node.getAttribute("href") ?? "";
    return SAFE_URL.test(href) ? surround(inner, "[", `](${href})`) : inner;
  }
  if (node.tagName === "S" || node.tagName === "DEL") return `~~${inner}~~`;
  let out = inner;
  if (isItalic(node)) out = surround(out, "*");
  if (isBold(node)) out = surround(out, "**");
  return out;
};

const blockContents = (node: HTMLElement, out: string[], prefix = ""): void => {
  const hasBlocks = [...node.children].some((c) => c instanceof HTMLElement && isBlock(c));
  if (hasBlocks) {
    let run = "";
    for (const child of node.childNodes) {
      if (child instanceof HTMLElement && isBlock(child)) {
        if (run.trim()) out.push(prefix + run.trim());
        run = "";
        block(child, out, prefix);
      } else run += inline(child);
    }
    if (run.trim()) out.push(prefix + run.trim());
    return;
  }
  const text = inline(node).trim();
  if (text) out.push(prefix + text);
};

const block = (node: Node, out: string[], prefix = ""): void => {
  if (!(node instanceof HTMLElement)) {
    const text = inline(node).trim();
    if (text) out.push(prefix + text);
    return;
  }
  const tag = node.tagName;
  if (preservesWhitespace(node)) {
    const text = literalText(node);
    const fence = codeFence(text, 3);
    out.push(`${fence}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`);
    return;
  }
  const heading = /^H([1-6])$/.exec(tag);
  if (heading) return void out.push(`${"#".repeat(Math.min(3, Number(heading[1])))} ${inline(node).trim()}`);
  if (tag === "TABLE") {
    const grid = [...node.querySelectorAll("tr")].map((tr) => [...tr.querySelectorAll("th,td")].map((c) => inline(c).trim()));
    if (grid.length) out.push(tableFromGrid(grid));
    return;
  }
  if (tag === "UL" || tag === "OL") {
    [...node.children].forEach((li, i) => {
      if (li.tagName !== "LI") return;
      const marker = tag === "OL" ? `${i + 1}. ` : "- ";
      const nested = [...li.childNodes].filter((c) => !(c instanceof HTMLElement && (c.tagName === "UL" || c.tagName === "OL")));
      out.push(`${prefix}${marker}${nested.map(inline).join("").trim()}`);
      li.querySelectorAll(":scope > ul, :scope > ol").forEach((sub) => block(sub, out, `${prefix}  `));
    });
    return;
  }
  if (tag === "BLOCKQUOTE") {
    const inner: string[] = [];
    blockContents(node, inner);
    out.push(
      inner
        .join("\n\n")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n"),
    );
    return;
  }
  if (tag === "HR") return void out.push("---");
  blockContents(node, out, prefix);
};

export const convertHtml = (html: string, code: boolean): { markdown: string; droppedImages: number } | null => {
  const doc = parseClipboardHtml(html);
  doc.querySelectorAll("style,script,meta,link,title,o\\:p,xml").forEach((el) => el.remove());
  const droppedImages = doc.querySelectorAll("img").length;
  const out: string[] = [];
  if (!code) block(doc, out);
  // Block boundaries supply their own spacing; normalizing the result would alter literal code.
  const markdown = code ? literalText(doc) : out.join("\n\n").trim();
  return markdown || droppedImages ? { markdown, droppedImages } : null;
};
