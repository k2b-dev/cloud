import { Marked, Renderer, type Tokens } from "marked";
import postcss from "postcss";
import {
  type GotenbergConfig,
  getGotenbergConfig,
  type RenderHtmlToPdfOptions,
  type RenderHtmlToPdfResult,
  renderHtmlToPdfWithConfig,
} from "./gotenberg";

export const MARKDOWN_PDF_MAX_CUSTOM_CSS_BYTES = 32 * 1024;
export const MARKDOWN_PDF_MAX_MARKDOWN_BYTES = 256 * 1024;

export const MARKDOWN_PDF_TEMPLATE_IDS = ["document", "report", "compact"] as const;
export type MarkdownPdfTemplateId = (typeof MARKDOWN_PDF_TEMPLATE_IDS)[number];

export type MarkdownPdfErrorCode = "bad_input" | "invalid_css" | "external_asset_unsupported";
export type MarkdownPdfErrorReason = "css_too_large" | "markdown_empty" | "unknown_template";

export class MarkdownPdfError extends Error {
  constructor(
    readonly code: MarkdownPdfErrorCode,
    message: string,
    readonly reason?: MarkdownPdfErrorReason,
  ) {
    super(message);
    this.name = "MarkdownPdfError";
  }
}

export type RenderMarkdownToPdfInput = {
  markdown: string;
  templateId?: MarkdownPdfTemplateId;
  customCss?: string;
};

export type RenderMarkdownToPdfOptions = RenderHtmlToPdfOptions;

const TEMPLATE_CSS: Record<MarkdownPdfTemplateId, string> = {
  document: `
@page { size: A4; margin: 22mm 20mm 24mm; }
:root { color: #1f2937; font: 11pt/1.55 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { margin: 0; background: #fff; }
.markdown-document { max-width: 100%; overflow-wrap: anywhere; }
h1, h2, h3, h4, h5, h6 { color: #111827; line-height: 1.2; margin: 1.4em 0 .55em; break-after: avoid-page; }
h1 { margin-top: 0; font-size: 2em; } h2 { font-size: 1.5em; } h3 { font-size: 1.2em; }
p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
a { color: #2563eb; text-decoration: underline; }
blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid #cbd5e1; color: #475569; }
code { border-radius: 3px; background: #f1f5f9; padding: .08em .28em; font: .9em/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { overflow-wrap: anywhere; white-space: pre-wrap; break-inside: avoid; border-radius: 6px; background: #f8fafc; padding: 1em; }
pre code { background: transparent; padding: 0; }
table { width: 100%; border-collapse: collapse; font-size: .94em; }
th, td { border: 1px solid #cbd5e1; padding: .5em .65em; text-align: left; vertical-align: top; }
th { background: #f1f5f9; font-weight: 650; }
thead { display: table-header-group; } tr { break-inside: avoid; }
hr { border: 0; border-top: 1px solid #cbd5e1; margin: 1.5em 0; }
`,
  report: `
@page { size: A4; margin: 24mm 22mm 26mm; }
:root { color: #263244; font: 10.75pt/1.58 Georgia, "Times New Roman", serif; }
body { margin: 0; background: #fff; }
.markdown-document { max-width: 100%; overflow-wrap: anywhere; }
h1, h2, h3, h4, h5, h6 { color: #13233a; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.18; break-after: avoid-page; }
h1 { margin: 0 0 .9em; padding-bottom: .35em; border-bottom: 2px solid #2f5f87; font-size: 2.15em; }
h2 { margin: 1.6em 0 .6em; padding-bottom: .2em; border-bottom: 1px solid #b8c7d6; font-size: 1.48em; }
h3 { margin: 1.35em 0 .5em; font-size: 1.15em; }
p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
a { color: #245a86; }
blockquote { margin-left: 0; padding: .7em 1em; border-left: 4px solid #4f799d; background: #f4f7fa; color: #41566c; }
code { border-radius: 3px; background: #edf2f7; padding: .08em .28em; font: .88em/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { overflow-wrap: anywhere; white-space: pre-wrap; break-inside: avoid; background: #f4f7fa; padding: 1em; }
pre code { background: transparent; padding: 0; }
table { width: 100%; border-collapse: collapse; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: .9em; }
th, td { border-bottom: 1px solid #b8c7d6; padding: .55em .7em; text-align: left; vertical-align: top; }
th { background: #e8eff5; color: #13233a; font-weight: 700; }
thead { display: table-header-group; } tr { break-inside: avoid; }
hr { border: 0; border-top: 1px solid #b8c7d6; margin: 1.6em 0; }
`,
  compact: `
@page { size: A4; margin: 14mm 15mm 16mm; }
:root { color: #20252b; font: 9pt/1.38 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { margin: 0; background: #fff; }
.markdown-document { max-width: 100%; overflow-wrap: anywhere; }
h1, h2, h3, h4, h5, h6 { color: #111827; line-height: 1.15; margin: 1em 0 .35em; break-after: avoid-page; }
h1 { margin-top: 0; font-size: 1.65em; } h2 { font-size: 1.3em; } h3 { font-size: 1.08em; }
p, ul, ol, blockquote, pre, table { margin: 0 0 .58em; }
ul, ol { padding-left: 1.5em; }
a { color: #1d4ed8; }
blockquote { margin-left: 0; padding-left: .7em; border-left: 2px solid #9ca3af; color: #4b5563; }
code { background: #f3f4f6; padding: .05em .2em; font: .88em/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { overflow-wrap: anywhere; white-space: pre-wrap; break-inside: avoid; background: #f7f7f8; padding: .65em; }
pre code { background: transparent; padding: 0; }
table { width: 100%; border-collapse: collapse; font-size: .88em; }
th, td { border: 1px solid #d1d5db; padding: .3em .42em; text-align: left; vertical-align: top; }
th { background: #f3f4f6; }
thead { display: table-header-group; } tr { break-inside: avoid; }
hr { border: 0; border-top: 1px solid #d1d5db; margin: .9em 0; }
`,
};

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const safeLink = (value: string): string | null => {
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f-\u009f\s]+/gu, "");
  return /^(?:javascript|vbscript|data|file):/iu.test(normalized) ? null : value;
};

const renderMarkdown = (source: string): string => {
  const renderer = new Renderer();
  renderer.html = ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtml(text);
  renderer.image = ({ href, title, text }: Tokens.Image) => {
    const label = escapeHtml(text.trim() ? `Image: ${text}` : "Image");
    const safeHref = safeLink(href);
    if (!safeHref) return label;
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapeHtml(safeHref)}"${titleAttribute}>${label}</a>`;
  };
  renderer.link = function ({ href, title, tokens }: Tokens.Link) {
    const body = this.parser.parseInline(tokens);
    const safeHref = safeLink(href);
    if (!safeHref) return body;
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapeHtml(safeHref)}"${titleAttribute}>${body}</a>`;
  };

  const parser = new Marked({ breaks: true, gfm: true, renderer });
  try {
    return parser.parse(source, { async: false }) as string;
  } catch (cause) {
    if (cause instanceof MarkdownPdfError) {
      throw new MarkdownPdfError(
        cause.code,
        cause.message.split("\nPlease report this to")[0]?.trim() || "Markdown could not be rendered.",
        cause.reason,
      );
    }
    throw new MarkdownPdfError("bad_input", "Markdown could not be rendered.");
  }
};

const validateCustomCss = (customCss: string): string => {
  if (byteLength(customCss) > MARKDOWN_PDF_MAX_CUSTOM_CSS_BYTES) {
    throw new MarkdownPdfError("invalid_css", "Custom CSS exceeds the 32 KiB limit.", "css_too_large");
  }

  let root: ReturnType<typeof postcss.parse>;
  try {
    root = postcss.parse(customCss);
  } catch {
    throw new MarkdownPdfError("invalid_css", "Custom CSS is not valid CSS.");
  }

  const resourceFunction = /(?:url|image-set|-webkit-image-set)\s*\(/iu;
  root.walkAtRules((rule) => {
    if (rule.name.toLowerCase() === "import" || resourceFunction.test(rule.params)) {
      throw new MarkdownPdfError("external_asset_unsupported", "Custom CSS cannot load external resources.");
    }
  });
  root.walkDecls((declaration) => {
    if (resourceFunction.test(declaration.value)) {
      throw new MarkdownPdfError("external_asset_unsupported", "Custom CSS cannot load external resources.");
    }
  });

  // Keep the CSS inside its style element even when input contains an HTML
  // end tag. The backslash is valid CSS escaping but no longer an HTML token.
  return root.toString().replace(/<\/style/giu, "<\\/style");
};

export const buildMarkdownPdfHtml = (input: RenderMarkdownToPdfInput): string => {
  if (typeof input.markdown !== "string" || !input.markdown.trim()) {
    throw new MarkdownPdfError("bad_input", "Markdown must not be empty.", "markdown_empty");
  }
  const templateId = input.templateId;
  if (templateId !== undefined && !MARKDOWN_PDF_TEMPLATE_IDS.includes(templateId)) {
    throw new MarkdownPdfError("bad_input", "Unknown Markdown PDF template.", "unknown_template");
  }

  const suppliedCustomCss = input.customCss?.trim() ?? "";
  const customCss = suppliedCustomCss ? validateCustomCss(input.customCss ?? "") : "";
  const presetCss = templateId ? TEMPLATE_CSS[templateId] : customCss ? "" : TEMPLATE_CSS.document;
  const stylesheet = `${presetCss}${presetCss && customCss ? `\n/* Custom CSS overrides */\n` : ""}${customCss}`;
  const content = renderMarkdown(input.markdown);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; frame-src 'none'; img-src 'none'; media-src 'none'; object-src 'none'; script-src 'none'; style-src 'unsafe-inline'">
<style>${stylesheet}</style>
</head>
<body><main class="markdown-document">${content}</main></body>
</html>`;
};

export const renderMarkdownToPdfWithConfig = (
  input: RenderMarkdownToPdfInput,
  config: GotenbergConfig,
  options: RenderMarkdownToPdfOptions = {},
): Promise<RenderHtmlToPdfResult> => renderHtmlToPdfWithConfig({ html: buildMarkdownPdfHtml(input) }, config, options);

export const renderMarkdownToPdf = async (
  input: RenderMarkdownToPdfInput,
  options: RenderMarkdownToPdfOptions = {},
): Promise<RenderHtmlToPdfResult> => renderMarkdownToPdfWithConfig(input, await getGotenbergConfig(), options);
