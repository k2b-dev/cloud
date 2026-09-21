import { z } from "zod";
import {
  MARKDOWN_PDF_MAX_CUSTOM_CSS_BYTES,
  MARKDOWN_PDF_MAX_MARKDOWN_BYTES,
  MARKDOWN_PDF_TEMPLATE_IDS,
  type RenderMarkdownToPdfInput,
  renderMarkdownToPdf,
} from "../services/pdf";
import { aiProjectFilePathFromMount } from "./file-mount";
import { type AiFileContent, aiFileStore, normalizeAiFilePath } from "./files-store";
import { defineAiTool } from "./tools";

export const CloudAiMarkdownToPdfInputSchema = z
  .object({
    path: z.string().trim().min(1).describe("Absolute path to an assistant-created Markdown file in this conversation."),
    template: z.enum(MARKDOWN_PDF_TEMPLATE_IDS).optional().describe("Optional A4 preset applied before custom CSS."),
    customCss: z.string().max(MARKDOWN_PDF_MAX_CUSTOM_CSS_BYTES).optional().describe("Optional bounded print CSS."),
  })
  .strict();

export const CloudAiMarkdownToPdfOutputSchema = z.object({
  sourcePath: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative(),
  mediaType: z.literal("application/pdf"),
});

type MarkdownPdfToolDependencies = {
  read?: (input: { conversationId: string; path: string }) => Promise<AiFileContent | null>;
  write?: (input: { conversationId: string; path: string; bytes: Uint8Array; mediaType: string; origin: "assistant" }) => Promise<void>;
  render?: (input: RenderMarkdownToPdfInput) => Promise<{ pdf: Uint8Array; contentType: string }>;
};

const conversationPath = (value: string): string => {
  const candidate = value.startsWith("/") ? value : `/${value}`;
  const path = normalizeAiFilePath(candidate);
  if (!path) throw new Error("Use an absolute conversation Markdown file path.");
  if (aiProjectFilePathFromMount(path) !== null) {
    throw new Error("Project files are read-only. Create a conversation Markdown file with write_file first.");
  }
  if (!path.toLowerCase().endsWith(".md")) throw new Error("markdown_to_pdf requires a .md file written with write_file.");
  return path;
};

const pdfPath = (path: string): string => `${path.slice(0, -3)}.pdf`;

export const createCloudAiMarkdownToPdfTool = (dependencies: MarkdownPdfToolDependencies = {}) => {
  const read = dependencies.read ?? aiFileStore.read;
  const write = dependencies.write ?? aiFileStore.write;
  const render = dependencies.render ?? renderMarkdownToPdf;

  return defineAiTool({
    name: "markdown_to_pdf",
    description:
      "Convert one assistant-created conversation Markdown file to a sibling PDF. Write or edit the .md source with write_file first. A named A4 template may be combined with custom CSS; custom CSS without a template is used as the complete stylesheet. The output path replaces .md with .pdf.",
    inputSchema: CloudAiMarkdownToPdfInputSchema,
    outputSchema: CloudAiMarkdownToPdfOutputSchema,
    approval: "never",
    timeoutMs: 125_000,
    promptHint:
      "write or edit an assistant-owned .md file with write_file before converting it with markdown_to_pdf; call present with the returned PDF path afterwards.",
  }).server(async (input, ctx) => {
    if (!ctx.conversationId) throw new Error("The markdown_to_pdf tool needs a conversation context.");
    const sourcePath = conversationPath(input.path);
    const source = await read({ conversationId: ctx.conversationId, path: sourcePath });
    if (!source) throw new Error(`No such file: ${sourcePath}`);
    if (source.origin !== "assistant") {
      throw new Error(`Create an assistant-owned Markdown file with write_file before converting ${sourcePath}.`);
    }
    if (source.bytes.byteLength > MARKDOWN_PDF_MAX_MARKDOWN_BYTES) {
      throw new Error(`Markdown exceeds the ${MARKDOWN_PDF_MAX_MARKDOWN_BYTES}-byte PDF rendering limit.`);
    }

    let markdown: string;
    try {
      markdown = new TextDecoder("utf-8", { fatal: true }).decode(source.bytes);
    } catch {
      throw new Error(`File ${sourcePath} is not valid UTF-8 Markdown.`);
    }

    const rendered = await render({ markdown, templateId: input.template, customCss: input.customCss });
    if (ctx.signal.aborted) {
      throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error("PDF conversion was cancelled.");
    }
    const path = pdfPath(sourcePath);
    await write({
      conversationId: ctx.conversationId,
      path,
      bytes: rendered.pdf,
      mediaType: "application/pdf",
      origin: "assistant",
    });
    return { sourcePath, path, size: rendered.pdf.byteLength, mediaType: "application/pdf" as const };
  });
};
