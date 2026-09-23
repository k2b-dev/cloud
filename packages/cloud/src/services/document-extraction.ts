import type { Format as AnyDocFormat } from "@firecrawl/anydoc";
import {
  formatFromBytes as anydocFormatFromBytes,
  formatFromExtension as anydocFormatFromExtension,
  toMarkdownBytes,
} from "@firecrawl/anydoc";

export const DOCUMENT_EXTRACTION_MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const DOCUMENT_EXTRACTION_MAX_OUTPUT_BYTES = 1024 * 1024;

export type DocumentFormat = "doc" | "docx" | "odt" | "pdf" | "ppt" | "pptx" | "rtf" | "epub" | "xlsx" | "ods" | "odp" | "csv";

export type DocumentExtractionErrorCode =
  | "cancelled"
  | "encrypted"
  | "internal"
  | "input_too_large"
  | "malformed"
  | "ocr_required"
  | "resource_limit"
  | "unsupported";

export class DocumentExtractionError extends Error {
  constructor(
    readonly code: DocumentExtractionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DocumentExtractionError";
  }
}

export type ExtractDocumentMarkdownInput = {
  bytes: Uint8Array;
  filename?: string | null;
  signal?: AbortSignal;
};

export type ExtractDocumentMarkdownResult = {
  format: DocumentFormat;
  markdown: string;
  inputBytes: number;
  outputBytes: number;
  truncated: boolean;
};

const anydocErrorCode = (error: unknown): string | null => {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
};

const cancelled = (): DocumentExtractionError => new DocumentExtractionError("cancelled", "Document extraction was cancelled.");

const assertNotCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw cancelled();
};

const filenameExtension = (filename: string | null | undefined): string | null => {
  const name = filename?.trim();
  if (!name) return null;
  const basename = name.split(/[\\/]/u).at(-1) ?? "";
  const dot = basename.lastIndexOf(".");
  return dot > 0 && dot < basename.length - 1 ? basename.slice(dot + 1) : null;
};

export const documentFormatFromFilename = (filename: string | null | undefined): DocumentFormat | null => {
  const extension = filenameExtension(filename);
  return extension ? (anydocFormatFromExtension(extension) as DocumentFormat | null) : null;
};

export const documentFormatFromBytes = (bytes: Uint8Array): DocumentFormat | null => anydocFormatFromBytes(bytes) as DocumentFormat | null;

const resolveFormat = (bytes: Uint8Array, filename: string | null | undefined): AnyDocFormat | null => {
  const detected = anydocFormatFromBytes(bytes);
  if (detected) return detected;
  const extension = filenameExtension(filename);
  const fromExtension = extension ? anydocFormatFromExtension(extension) : null;
  return fromExtension === "csv" ? fromExtension : null;
};

const truncateUtf8 = (value: string, limit: number): { value: string; bytes: number; truncated: boolean } => {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= limit) return { value, bytes: encoded.byteLength, truncated: false };

  for (let trim = 0; trim <= 3; trim += 1) {
    try {
      const slice = encoded.slice(0, limit - trim);
      return {
        value: new TextDecoder("utf-8", { fatal: true }).decode(slice),
        bytes: slice.byteLength,
        truncated: true,
      };
    } catch {
      // A byte limit can split one UTF-8 code point by at most three bytes.
    }
  }
  throw new DocumentExtractionError("malformed", "Extracted document text is not valid UTF-8.");
};

const mapConversionError = (error: unknown, format: DocumentFormat): DocumentExtractionError => {
  switch (anydocErrorCode(error)) {
    case "encrypted":
      return new DocumentExtractionError("encrypted", "The document is encrypted or password-protected.");
    case "resourceLimit":
      return new DocumentExtractionError("resource_limit", "The document exceeds safe extraction limits.");
    case "malformed":
    case "missingPart":
      return new DocumentExtractionError("malformed", "The document is malformed or incomplete.");
    case "needsOcr":
      return new DocumentExtractionError("ocr_required", "The PDF has no readable text and requires OCR.");
    case "unsupported":
      return format === "pdf"
        ? new DocumentExtractionError("ocr_required", "The PDF has no readable text and requires OCR.")
        : new DocumentExtractionError("unsupported", "The document format is not supported.");
    default:
      return new DocumentExtractionError("internal", "The document could not be extracted.");
  }
};

export const extractDocumentMarkdown = async (input: ExtractDocumentMarkdownInput): Promise<ExtractDocumentMarkdownResult> => {
  assertNotCancelled(input.signal);
  if (input.bytes.byteLength === 0) throw new DocumentExtractionError("malformed", "The document is empty.");
  if (input.bytes.byteLength > DOCUMENT_EXTRACTION_MAX_INPUT_BYTES) {
    throw new DocumentExtractionError(
      "input_too_large",
      `The document exceeds the ${DOCUMENT_EXTRACTION_MAX_INPUT_BYTES}-byte extraction limit.`,
    );
  }

  const format = resolveFormat(input.bytes, input.filename);
  if (!format) throw new DocumentExtractionError("unsupported", "The document format is not supported.");
  const publicFormat = format as DocumentFormat;

  let markdown: string;
  try {
    markdown = await toMarkdownBytes(input.bytes, format);
  } catch (error) {
    throw mapConversionError(error, publicFormat);
  }
  assertNotCancelled(input.signal);

  const bounded = truncateUtf8(markdown, DOCUMENT_EXTRACTION_MAX_OUTPUT_BYTES);
  return {
    format: publicFormat,
    markdown: bounded.value,
    inputBytes: input.bytes.byteLength,
    outputBytes: bounded.bytes,
    truncated: bounded.truncated,
  };
};
