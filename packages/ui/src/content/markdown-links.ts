import { fileIcons } from "@k2b/stdlib";
import type { Token, Tokens } from "marked";
import { resolveUiMessages, type UiMessages } from "../intl/messages";

/** What a reference points to inside the host application. */
export type MarkdownReferenceKind = "file" | "note" | "heading" | "task" | "page";

/** The type a reference shows: a file's type from its extension, or the kind of the referenced content. */
export type MarkdownReferenceType = "pdf" | "image" | "design" | "file" | "note" | "heading" | "task" | "page";

/**
 * A link to content inside the host application, as opposed to a web or mail link.
 * References render as a calm pill whose icon names the type.
 */
export type MarkdownReference = {
  kind: MarkdownReferenceKind;
  /** The file's name, which decides its type and icon. Defaults to the link text. */
  fileName?: string;
  /** The file's formatted size. It shows only when the link stands alone on its line. */
  size?: string;
  /** Plain-text title of the document that holds a heading, for a heading in another document. */
  document?: string;
};

export type MarkdownLinkInput = {
  /** The final, already validated link destination. */
  href: string;
  /** The rendered link text. It crosses a trust boundary: the caller sanitizes it. */
  html: string;
  /** The link text as plain text, for the accessible name. Defaults to the text of `html`. */
  text?: string;
  title?: string;
  target?: "_blank";
  /** Link relations without a new tab, such as `noreferrer`. `target: "_blank"` always sets `noopener noreferrer`. */
  rel?: string;
  /** A reference inside the host. Without one, the link is a web link, or a mail link for `mailto:` and `tel:`. */
  reference?: MarkdownReference | null;
  /** The link is the only content of its line. Only then does a file show its size. */
  standalone?: boolean;
  /** Locale of the type name in the accessible name. Defaults to English on the server and the page language in the browser. */
  locale?: string;
};

const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg", "heic", "heif", "tif", "tiff"]);
const DESIGN_EXTENSIONS = new Set(["afdesign", "afphoto", "afpub", "psd", "psb", "ai", "eps", "indd", "idml", "fig", "sketch", "xd"]);

const extensionOf = (name: string): string | null => {
  const match = /\.([a-z0-9]{1,10})$/i.exec(name.trim());
  return match && /[a-z]/i.test(match[1]!) ? match[1]!.toLowerCase() : null;
};

/** The type of a file reference, from the extension of its name. */
export const markdownFileType = (fileName: string): "pdf" | "image" | "design" | "file" => {
  const extension = extensionOf(fileName);
  if (extension === "pdf") return "pdf";
  if (extension && IMAGE_EXTENSIONS.has(extension)) return "image";
  if (extension && DESIGN_EXTENSIONS.has(extension)) return "design";
  return "file";
};

/**
 * The reference a link destination names on its own: `#anchor` is a heading in the same document, and any other
 * relative URL is a page of the host, or a file when its last path segment has a file extension. Absolute URLs,
 * protocol-relative URLs and every scheme are web or mail links; the result is then `null`.
 */
export const markdownLinkReference = (href: string): MarkdownReference | null => {
  const url = href.trim();
  if (!url || url.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(url)) return null;
  if (url.startsWith("#")) return { kind: "heading" };
  const segment = url.split(/[?#]/, 1)[0]!.split("/").pop() ?? "";
  let fileName = segment;
  try {
    fileName = decodeURIComponent(segment);
  } catch {
    /* A malformed escape stays literal text. */
  }
  return extensionOf(fileName) ? { kind: "file", fileName } : { kind: "page" };
};

/** The type a reference shows. */
export const markdownReferenceType = (reference: MarkdownReference, text: string): MarkdownReferenceType =>
  reference.kind === "file" ? markdownFileType(reference.fileName ?? text) : reference.kind;

const TYPE_ICONS: Record<Exclude<MarkdownReferenceType, "file">, string> = {
  pdf: "ti-file-type-pdf",
  image: "ti-photo",
  design: "ti-vector-bezier-2",
  note: "ti-file-text",
  heading: "ti-hash",
  task: "ti-circle-check",
  page: "ti-link",
};

/** The Tabler glyph of a reference type; any other file keeps the glyph of its file family. */
export const markdownReferenceIcon = (type: MarkdownReferenceType, fileName = ""): string =>
  type === "file" ? (fileIcons.getFileIcon({ name: fileName, type: "file" }).split(/\s+/)[0] ?? "ti-file") : TYPE_ICONS[type];

const TYPE_LABELS: Record<MarkdownReferenceType, keyof UiMessages> = {
  pdf: "referencePdf",
  image: "referenceImage",
  design: "referenceDesign",
  file: "referenceFile",
  note: "referenceNote",
  heading: "referenceHeading",
  task: "referenceTask",
  page: "referencePage",
};

/** The localized name of a reference type, such as "PDF" or "Überschrift". */
export const markdownReferenceTypeLabel = (type: MarkdownReferenceType, locale?: string): string =>
  String(resolveUiMessages(locale)[TYPE_LABELS[type]]);

/** The text of rendered inline HTML. */
const htmlText = (html: string): string =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(
      /&(amp|lt|gt|quot|#39);/g,
      (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[entity] ?? entity,
    );

const isMailHref = (href: string) => /^(?:mailto|tel):/i.test(href.trim());

/**
 * One link of rendered Markdown. A reference to content of the host renders as a calm pill: a neutral fill, the
 * text in the prose colour, and an icon whose colour names the type. Its accessible name starts with the type, as
 * in "PDF: Brand-2026.pdf". A heading in another document shows that document first ("Notes › Heading"). A web
 * link stays prose text with a thin underline in the link accent and a small ↗; a mail link has no arrow.
 */
export const renderMarkdownLink = (input: MarkdownLinkInput): string => {
  const titleAttribute = input.title ? ` title="${escapeHtml(input.title)}"` : "";
  const targetAttributes =
    input.target === "_blank" ? ' target="_blank" rel="noopener noreferrer"' : input.rel ? ` rel="${escapeHtml(input.rel)}"` : "";
  const href = escapeHtml(input.href);
  const reference = input.reference;
  if (!reference) {
    const mail = isMailHref(input.href);
    const arrow = mail ? "" : '<i class="k2b-text-link__external ti ti-arrow-up-right" aria-hidden="true"></i>';
    return `<a href="${href}" class="k2b-text-link" data-link="${mail ? "mail" : "web"}"${titleAttribute}${targetAttributes}>${input.html}${arrow}</a>`;
  }
  const text = (input.text ?? htmlText(input.html)).trim();
  const type = markdownReferenceType(reference, text);
  const icon = markdownReferenceIcon(type, reference.fileName ?? text);
  const size = input.standalone && reference.kind === "file" && reference.size ? reference.size : "";
  const document = reference.kind === "heading" ? (reference.document?.trim() ?? "") : "";
  const name = `${markdownReferenceTypeLabel(type, input.locale)}: ${document ? `${document} › ` : ""}${text}${size ? `, ${size}` : ""}`;
  return (
    `<a href="${href}" class="k2b-reference" data-reference="${type}" aria-label="${escapeHtml(name)}"${titleAttribute}${targetAttributes}>` +
    `<i class="k2b-reference__icon ti ${icon}" aria-hidden="true"></i>` +
    (document ? `<span class="k2b-reference__document">${escapeHtml(document)} ›</span> ` : "") +
    input.html +
    (size ? `<span class="k2b-reference__size">${escapeHtml(size)}</span>` : "") +
    `</a>`
  );
};

const isBlank = (token: Token) => (token.type === "text" || token.type === "space") && !token.raw.trim();
const isLink = (token: Token | undefined): token is Tokens.Link => token?.type === "link";

/**
 * The links among `tokens` that stand alone on their line: the only content of a paragraph or list item line,
 * between line breaks. Pass the result's check as `standalone` to `renderMarkdownLink`, so a file shows its size
 * in a list of files but not inside a sentence. Call it from `walkTokens` of a renderer with GFM line breaks
 * (`breaks: true`), where every source line is a visual line.
 */
export const markStandaloneLinks = (token: Token, standalone: WeakSet<Tokens.Link>): void => {
  if ((token.type !== "paragraph" && token.type !== "text") || !("tokens" in token) || !token.tokens) return;
  let line: Token[] = [];
  const close = () => {
    const content = line.filter((candidate) => !isBlank(candidate));
    if (content.length === 1 && isLink(content[0])) standalone.add(content[0]);
    line = [];
  };
  for (const child of token.tokens) {
    if (child.type === "br") {
      close();
      continue;
    }
    const plain = child.type === "text" && !("tokens" in child && child.tokens?.length) ? child.raw : "";
    if (plain.includes("\n")) {
      for (const [index, part] of plain.split("\n").entries()) {
        if (index > 0) close();
        if (part.trim()) line.push({ type: "text", raw: part, text: part });
      }
      continue;
    }
    line.push(child);
  }
  close();
};
