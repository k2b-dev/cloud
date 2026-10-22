/**
 * Clean paste: HTML from Word, Google Docs or web pages becomes the editor's
 * small Markdown set. Styles, classes, fonts, colours and images are dropped.
 * Tab-separated text (Excel, Sheets, Numbers) becomes a table.
 */
import { EditorView } from "@codemirror/view";
import { inspectClipboard } from "./clipboard";
import { tableFromGrid } from "./markdown-table";
import { tableHost } from "./table";

const SAFE_URL = /^(https?:|mailto:)/i;

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
  const hasBlocks = [...node.children].some((c) => /^(P|DIV|H[1-6]|UL|OL|TABLE|BLOCKQUOTE|PRE|HR|SECTION|ARTICLE)$/.test(c.tagName));
  if (hasBlocks) {
    let run = "";
    for (const child of node.childNodes) {
      if (child instanceof HTMLElement && /^(P|DIV|H[1-6]|UL|OL|TABLE|BLOCKQUOTE|PRE|HR|SECTION|ARTICLE)$/.test(child.tagName)) {
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
  if (tag === "PRE") {
    const text = (node.textContent ?? "").replace(/\n$/, "");
    const fence = codeFence(text, 3);
    out.push(`${fence}\n${text}\n${fence}`);
    return;
  }
  if (tag === "HR") return void out.push("---");
  blockContents(node, out, prefix);
};

/** HTML clipboard content as Markdown; `null` when it is better pasted as plain text. */
export const htmlToMarkdown = (html: string): { markdown: string; droppedImages: number } | null => {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("style,script,meta,link,title,o\\:p,xml").forEach((el) => el.remove());
  const droppedImages = doc.querySelectorAll("img").length;
  const out: string[] = [];
  block(doc.body, out);
  // Block boundaries supply their own spacing; normalizing the result would alter literal code.
  const markdown = out.join("\n\n").trim();
  return markdown || droppedImages ? { markdown, droppedImages } : null;
};

export const cleanPaste = (onDroppedImages?: (count: number, files: File[]) => void, plain = false) =>
  EditorView.domEventHandlers({
    paste(event, view) {
      if (view.state.readOnly) return false;
      const data = event.clipboardData;
      if (!data) return false;
      const host = view.state.facet(tableHost);
      const clipboard = inspectClipboard(data, {
        maxLength: host?.maxLength ?? Infinity,
        maxPasteCells: plain ? Infinity : (host?.maxPasteCells ?? 2000),
      });
      if ("error" in clipboard) {
        event.preventDefault();
        host?.onError(clipboard.error);
        return true;
      }
      const { html, text, tsv: grid, images, files } = clipboard;
      if (images) onDroppedImages?.(images, files);
      if (plain) {
        if (images && !text) {
          event.preventDefault();
          return true;
        }
        return false;
      }
      let insert: string | null = null;
      if (html) {
        const converted = htmlToMarkdown(html);
        if (converted) {
          insert = converted.markdown;
        }
      }
      if (insert === null && grid?.length) insert = tableFromGrid(grid);
      if (insert === null) {
        if (images && !text) {
          event.preventDefault();
          return true;
        }
        return false;
      }
      event.preventDefault();
      const block = insert.includes("\n") && /^(\||#|>|- |\d+\. |```)/m.test(insert);
      const { from, to } = view.state.selection.main;
      if (block) {
        // A block never glues onto the text around it: a table row must not swallow the next paragraph.
        const doc = view.state.doc;
        const before = doc.sliceString(Math.max(0, from - 2), from);
        const after = doc.sliceString(to, Math.min(doc.length, to + 2));
        const lead = from === 0 || before === "\n\n" ? "" : before.endsWith("\n") ? "\n" : "\n\n";
        const trail = to === doc.length || after === "\n\n" ? "" : after.startsWith("\n") ? "\n" : "\n\n";
        insert = `${lead}${insert}${trail}`;
      }
      view.dispatch(view.state.replaceSelection(insert), { userEvent: "input.paste" });
      return true;
    },
  });
