import { z } from "zod";
import {
  type GotenbergConfig,
  getGotenbergConfig,
  MARKDOWN_PDF_MAX_CUSTOM_CSS_BYTES,
  type RenderHtmlToPdfInput,
  type RenderHtmlToPdfOptions,
  type RenderHtmlToPdfResult,
  renderHtmlToPdfWithConfig,
} from "../services/pdf";
import { aiProjectFilePathFromMount, aiSkillFilePathFromMount } from "./file-mount";
import { type AiFileContent, type AiFileStat, aiFileStore, normalizeAiFilePath } from "./files-store";
import { withAiPdfConversionSlot } from "./pdf-conversions";
import { defineAiTool } from "./tools";

/** The same bound as the chat input files of one code_run. */
export const HTML_PDF_MAX_ASSETS = 64;

const FilePath = z.string().trim().min(1);
const Margin = z.number().finite().nonnegative();

export const CloudAiHtmlToPdfInputSchema = z
  .object({
    path: FilePath.describe("Absolute path to an assistant-created .html file in this conversation."),
    cssPath: FilePath.optional().describe("Optional conversation CSS file, applied after the document's own styles."),
    customCss: z.string().max(MARKDOWN_PDF_MAX_CUSTOM_CSS_BYTES).optional().describe("Optional inline CSS, applied last."),
    headerPath: FilePath.optional().describe("Optional conversation HTML file printed at the top of every page."),
    footerPath: FilePath.optional().describe("Optional conversation HTML file printed at the bottom of every page."),
    assets: z
      .array(FilePath)
      .max(HTML_PDF_MAX_ASSETS)
      .optional()
      .describe("Conversation image or font files. The HTML and CSS reference each by its file name only, such as logo.png."),
    page: z
      .object({
        format: z.enum(["A4", "A3", "A5", "Letter", "Legal"]).optional().describe("Paper size. Default A4."),
        landscape: z.boolean().optional().describe("Landscape orientation. Default false."),
        margin: z
          .object({ top: Margin.optional(), right: Margin.optional(), bottom: Margin.optional(), left: Margin.optional() })
          .strict()
          .optional()
          .describe("Page margins in millimeters. Each defaults to 15."),
      })
      .strict()
      .optional(),
  })
  .strict();

export const CloudAiHtmlToPdfOutputSchema = z.object({
  sourcePath: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative(),
  mediaType: z.literal("application/pdf"),
});

type HtmlPdfToolDependencies = {
  stat?: (input: { conversationId: string; path: string }) => Promise<AiFileStat | null>;
  read?: (input: { conversationId: string; path: string }) => Promise<AiFileContent | null>;
  write?: (input: { conversationId: string; path: string; bytes: Uint8Array; mediaType: string; origin: "assistant" }) => Promise<void>;
  config?: () => Promise<GotenbergConfig>;
  render?: (input: RenderHtmlToPdfInput, config: GotenbergConfig, options: RenderHtmlToPdfOptions) => Promise<RenderHtmlToPdfResult>;
};

const HTML_EXTENSION = /\.html?$/i;

const conversationPath = (value: string, role: "source" | "input"): string => {
  const path = normalizeAiFilePath(value.startsWith("/") ? value : `/${value}`);
  if (!path) throw new Error(`Use an absolute conversation file path instead of ${value}.`);
  if (aiProjectFilePathFromMount(path) !== null || aiSkillFilePathFromMount(path) !== null) {
    throw new Error(
      role === "source"
        ? "html_to_pdf converts only conversation files; copy the HTML into a conversation file with write_file first."
        : `html_to_pdf reads only files of this conversation, not ${path}.`,
    );
  }
  if (role === "source" && !HTML_EXTENSION.test(path)) throw new Error("html_to_pdf requires a .html file written with write_file.");
  return path;
};

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const utf8 = (file: AiFileContent): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    throw new Error(`File ${file.path} is not valid UTF-8 text.`);
  }
};

const cancelled = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error("PDF conversion was cancelled.");

export const createCloudAiHtmlToPdfTool = (dependencies: HtmlPdfToolDependencies = {}) => {
  const stat = dependencies.stat ?? aiFileStore.stat;
  const read = dependencies.read ?? aiFileStore.read;
  const write = dependencies.write ?? aiFileStore.write;
  const loadConfig = dependencies.config ?? getGotenbergConfig;
  const render = dependencies.render ?? renderHtmlToPdfWithConfig;

  return defineAiTool({
    name: "html_to_pdf",
    description:
      'Convert one assistant-created conversation HTML file to a sibling PDF; the output path replaces .html with .pdf. Use it when the layout needs HTML and CSS, such as columns, exact tables, letterheads, invoices, certificates, images, or custom fonts; use markdown_to_pdf for text-first documents. Write the .html source with write_file first, appending long files in parts; CSS, header, footer, and asset files can be any conversation files, including uploads. Rendering is offline without JavaScript: scripts, frames, and remote URLs are removed or blocked, and MathML and the SVG foreignObject and desc elements are removed, so write formulas and labels as HTML and CSS or as SVG text. Embed images and fonts as data: URLs, or list conversation files in assets and reference each by its file name only, for example <img src="logo.png"> or url("brand.woff2"); percent-encode #, ?, %, and : in a name, such as logo%232.png for logo#2.png. cssPath and customCss apply after the document\'s own styles. page sets paper size (default A4), orientation, and millimeter margins (default 15); CSS @page sizes are ignored. Header and footer files are small separate HTML documents with their own inline styles; they load no assets, so use data: URLs for images there. <span class="pageNumber"></span> and <span class="totalPages"></span> print page numbers, and the top or bottom margin must leave room for them. The HTML <title> names the PDF in viewers; without one, the file name does. All input files share the configured PDF input budget. Call present with the returned path. To also save the PDF in Files, follow the PDF reference of the assistant-code-mode skill.',
    inputSchema: CloudAiHtmlToPdfInputSchema,
    outputSchema: CloudAiHtmlToPdfOutputSchema,
    approval: "never",
    timeoutMs: 125_000,
    promptHint:
      "for PDFs whose layout needs HTML and CSS, images, or fonts: write an assistant-owned .html file with write_file, convert it with html_to_pdf, then call present with the returned PDF path.",
  }).server(async (input, ctx) => {
    const conversationId = ctx.conversationId;
    if (!conversationId) throw new Error("The html_to_pdf tool needs a conversation context.");
    const sourcePath = conversationPath(input.path, "source");
    const cssPath = input.cssPath === undefined ? undefined : conversationPath(input.cssPath, "input");
    const headerPath = input.headerPath === undefined ? undefined : conversationPath(input.headerPath, "input");
    const footerPath = input.footerPath === undefined ? undefined : conversationPath(input.footerPath, "input");
    const assetPaths = (input.assets ?? []).map((path) => conversationPath(path, "input"));
    const config = await loadConfig();

    // Check every file and the shared input budget before loading any bytes.
    let total = new TextEncoder().encode(input.customCss ?? "").byteLength;
    for (const path of [sourcePath, cssPath, headerPath, footerPath, ...assetPaths]) {
      if (path === undefined) continue;
      const file = await stat({ conversationId, path });
      if (!file) throw new Error(`No such file: ${path}`);
      if (path === sourcePath && file.origin !== "assistant") {
        throw new Error(`Create an assistant-owned HTML file with write_file before converting ${sourcePath}.`);
      }
      total += file.size;
      if (total > config.maxHtmlBytes) {
        throw new Error(`The HTML, CSS, header, footer, and assets exceed the ${config.maxHtmlBytes}-byte PDF input budget.`);
      }
    }

    const load = async (path: string): Promise<AiFileContent> => {
      const file = await read({ conversationId, path });
      if (!file) throw new Error(`No such file: ${path}`);
      return file;
    };
    const text = async (path: string | undefined): Promise<string | undefined> => (path === undefined ? undefined : utf8(await load(path)));

    const source = utf8(await load(sourcePath));
    const css = [await text(cssPath), input.customCss].filter((value) => value?.trim()).join("\n");
    if (/<\/style/i.test(css)) throw new Error("CSS cannot contain </style.");
    const headerHtml = await text(headerPath);
    const footerHtml = await text(footerPath);
    const assets: RenderHtmlToPdfInput["assets"] = [];
    for (const path of assetPaths) {
      const file = await load(path);
      assets.push({ name: basename(path), data: new Blob([new Uint8Array(file.bytes)], { type: file.mediaType }) });
    }

    let rendered: RenderHtmlToPdfResult;
    try {
      rendered = await withAiPdfConversionSlot(() =>
        render(
          {
            // Like Code Mode, the document renders in standards mode. Separate CSS
            // follows the document, so it wins over the document's own styles.
            html: `<!doctype html>${source}${css ? `\n<style>\n${css}\n</style>\n` : ""}`,
            title: basename(sourcePath).replace(HTML_EXTENSION, ""),
            headerHtml,
            footerHtml,
            assets,
            page: { format: input.page?.format ?? "A4", landscape: input.page?.landscape ?? false, margin: input.page?.margin },
            tagged: true,
          },
          config,
          { signal: ctx.signal },
        ),
      );
    } catch (error) {
      throw ctx.signal.aborted ? cancelled(ctx.signal) : error;
    }
    if (ctx.signal.aborted) throw cancelled(ctx.signal);

    const path = sourcePath.replace(HTML_EXTENSION, ".pdf");
    await write({ conversationId, path, bytes: rendered.pdf, mediaType: "application/pdf", origin: "assistant" });
    return { sourcePath, path, size: rendered.pdf.byteLength, mediaType: "application/pdf" as const };
  });
};
