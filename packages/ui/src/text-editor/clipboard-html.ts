import DOMPurify from "dompurify";

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
      "strike",
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
    ALLOWED_ATTR: ["href", "style", "start"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM: true,
  });
  if (!(body instanceof HTMLElement)) throw new TypeError("Clipboard HTML did not produce an HTML element");
  return body;
};

const SAFE_URL = /^(https?:|mailto:)/i;
const preservesWhitespace = (node: HTMLElement) =>
  node.tagName === "PRE" || (/^(DIV|P)$/.test(node.tagName) && /^(pre|pre-wrap|break-spaces)$/.test(node.style.whiteSpace));
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

const escapeText = (text: string, table: boolean): string =>
  text.replace(/\s+/g, " ").replace(/https?:\/\/[^\s<>]+|[\\`*_[<~|]/g, (token, at: number, source: string) => {
    if (token.length > 1) return table ? token.replace(/\|/g, "\\|") : token;
    if (token === "|" && !table) return token;
    if (token === "~" && /\s/.test(source[at - 1] ?? " ") && /\s/.test(source[at + 1] ?? " ")) return token;
    if (token === "_" && /[\p{L}\p{N}]/u.test(source[at - 1] ?? "") && /[\p{L}\p{N}]/u.test(source[at + 1] ?? "")) return token;
    return "\\" + token;
  });

// A literal exclamation before an emitted link must not turn that link into an image.
const joinInline = (before: string, after: string): string =>
  (before.endsWith("!") && after.startsWith("[") ? before.slice(0, -1) + "\\!" : before) + after;

const inline = (node: Node, table = false): string => {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent ?? "", table);
  if (!(node instanceof HTMLElement)) return "";
  if (node.tagName === "BR") return "\n";
  if (node.tagName === "IMG") return "";
  if (node.tagName === "CODE") {
    const raw = node.textContent ?? "";
    const text = table ? raw.replace(/\|/g, "\\|") : raw;
    if (!text) return "";
    const fence = codeFence(text, 1);
    const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
    return `${fence}${padding}${text}${padding}${fence}`;
  }
  const inner = [...node.childNodes].reduce((text, child) => joinInline(text, inline(child, table)), "");
  if (!inner.trim()) return inner;
  if (node.tagName === "A") {
    const href = node.getAttribute("href") ?? "";
    return SAFE_URL.test(href) ? surround(inner, "[", `](${href.replace(/[\\()]/g, "\\$&").replace(/\|/g, "%7C")})`) : inner;
  }
  if (node.tagName === "S" || node.tagName === "DEL" || node.tagName === "STRIKE") return `~~${inner}~~`;
  let out = inner;
  if (isItalic(node)) out = surround(out, "*");
  if (isBold(node)) out = surround(out, "**");
  return out;
};

const containsBlock = (node: HTMLElement): boolean =>
  [...node.children].some((child) => child instanceof HTMLElement && (isBlock(child) || containsBlock(child)));

// Apply line-start rules after joining spans, so a split "1" + ". January"
// stays literal too. Mid-sentence punctuation needs no Markdown escape.
const escapeBlockStart = (text: string) =>
  text.replace(
    /(^|\n)([ \t]*)(\d+[.)]|[-+=]+|#+)(?=\s|$)/g,
    (_match, line: string, space: string, marker: string) =>
      line + space + (/^\d/.test(marker) ? `${marker.slice(0, -1)}\\${marker.at(-1)}` : `\\${marker}`),
  );

const blockContents = (node: HTMLElement, out: string[], prefix = ""): void => {
  if (containsBlock(node)) {
    let run = "";
    for (const child of node.childNodes) {
      if (child instanceof HTMLElement && (isBlock(child) || containsBlock(child))) {
        if (run.trim()) out.push(prefix + escapeBlockStart(run.trim()));
        run = "";
        block(child, out, prefix);
      } else run = joinInline(run, inline(child));
    }
    if (run.trim()) out.push(prefix + escapeBlockStart(run.trim()));
    return;
  }
  const text = inline(node).trim();
  if (text) out.push(prefix + escapeBlockStart(text));
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
    // Cells already contain escaped Markdown. The plain-text grid converter
    // would escape those backslashes a second time and change their meaning.
    const grid = [...node.querySelectorAll("tr")].map((tr) =>
      [...tr.querySelectorAll("th,td")].map((cell) => inline(cell, true).trim().replace(/\n/g, " ")),
    );
    if (grid.length) {
      const columns = grid.reduce((width, row) => Math.max(width, row.length), 1);
      const rows = grid.map((row) => `| ${Array.from({ length: columns }, (_, column) => row[column] ?? "").join(" | ")} |`);
      rows.splice(1, 0, `|${" --- |".repeat(columns)}`);
      out.push(rows.join("\n"));
    }
    return;
  }
  if (tag === "UL" || tag === "OL") {
    const lines: string[] = [];
    let ordinal = Number.parseInt(node.getAttribute("start") ?? "1", 10);
    if (!Number.isFinite(ordinal)) ordinal = 1;
    let indent = `${prefix}  `;
    for (const child of node.children) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.tagName === "UL" || child.tagName === "OL") {
        // Docs emits a sublist beside its parent LI instead of inside it.
        block(child, lines, indent);
        continue;
      }
      if (child.tagName !== "LI") continue;
      const marker = tag === "OL" ? `${ordinal++}. ` : "- ";
      indent = prefix + " ".repeat(marker.length);
      const chunks: string[] = [];
      blockContents(child, chunks);
      const body = chunks
        .reduce((text, chunk) => text + (text ? (/^(?:- |\d+\. )/.test(chunk) ? "\n" : "\n\n") : "") + chunk, "")
        .split("\n");
      lines.push(prefix + marker + (body.shift() ?? ""), ...body.map((line) => (line ? indent + line : "")));
    }
    out.push(lines.join("\n"));
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
