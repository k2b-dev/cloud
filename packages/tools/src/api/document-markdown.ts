import { type AuthContext, auth, getLocale, jsonResponse, type RateLimitConfig, rateLimit, requiresAuth, v } from "@k2b/cloud/server";
import {
  DOCUMENT_EXTRACTION_MAX_INPUT_BYTES,
  DocumentExtractionError,
  type DocumentExtractionErrorCode,
  extractDocumentMarkdown,
} from "@k2b/cloud/services/document-extraction";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { documentMarkdownMessages } from "./document-markdown-messages";

// Public transport budget for exactly one multipart field: RFC boundary,
// content-disposition, a 255-character filename, media type, and delimiters.
export const DOCUMENT_MARKDOWN_MULTIPART_METADATA_BYTES = 8 * 1024;
export const DOCUMENT_MARKDOWN_MAX_REQUEST_BYTES = DOCUMENT_EXTRACTION_MAX_INPUT_BYTES + DOCUMENT_MARKDOWN_MULTIPART_METADATA_BYTES;
const DOCUMENT_MARKDOWN_MAX_ACTIVE_CONVERSIONS = 2;

const DocumentMarkdownRequestSchema = z.object({
  file: z.file(),
});

export const DocumentMarkdownResponseSchema = z.object({
  filename: z.string(),
  format: z.enum(["doc", "docx", "odt", "pdf", "ppt", "pptx", "rtf", "epub", "xlsx", "ods", "odp", "csv"]),
  markdown: z.string(),
  inputBytes: z.number().int().nonnegative(),
  outputBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const DocumentMarkdownErrorSchema = z.object({
  code: z
    .enum(["cancelled", "encrypted", "internal", "input_too_large", "malformed", "ocr_required", "resource_limit", "unsupported"])
    .optional(),
  message: z.string(),
});

type ExtractDocument = typeof extractDocumentMarkdown;

type DocumentMarkdownRouteDependencies = {
  authenticate?: MiddlewareHandler<AuthContext>;
  rateLimiter?: MiddlewareHandler<AuthContext>;
  extract?: ExtractDocument;
};

const documentRateLimit: RateLimitConfig = {
  keyBy: "user",
  // Four conversions per ten-second window keeps one interactive user fluid
  // while bounding bursts of native conversion work.
  limitPerSecond: 4,
  windowSecs: 10,
};

const errorStatus = (code: DocumentExtractionErrorCode): 400 | 408 | 413 | 422 | 500 => {
  switch (code) {
    case "cancelled":
      return 408;
    case "input_too_large":
      return 413;
    case "encrypted":
    case "malformed":
    case "ocr_required":
    case "resource_limit":
    case "unsupported":
      return 422;
    case "internal":
      return 500;
  }
};

const resolveMessages = (c: Parameters<typeof getLocale>[0]) => documentMarkdownMessages.resolve([getLocale(c)]).t;

const documentError = (error: unknown, extractionFailed: string): DocumentExtractionError =>
  error instanceof DocumentExtractionError ? error : new DocumentExtractionError("internal", extractionFailed);

const requireBoundedMultipart = (): MiddlewareHandler<AuthContext> => async (c, next) => {
  const t = resolveMessages(c);
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    return c.json({ code: "malformed" as const, message: t.uploadMultipart }, 400);
  }

  const rawLength = c.req.header("content-length");
  const contentLength = rawLength && /^\d+$/u.test(rawLength) ? Number(rawLength) : Number.NaN;
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    return c.json({ code: "malformed" as const, message: t.contentLengthRequired }, 400);
  }
  if (contentLength > DOCUMENT_MARKDOWN_MAX_REQUEST_BYTES) {
    return c.json(
      {
        code: "input_too_large" as const,
        message: t.documentTooLarge,
      },
      413,
    );
  }

  await next();
};

const documentBodyLimit = bodyLimit({
  maxSize: DOCUMENT_MARKDOWN_MAX_REQUEST_BYTES,
  onError: (c) =>
    c.json(
      {
        code: "input_too_large" as const,
        message: resolveMessages(c).documentTooLarge,
      },
      413,
    ),
});

const noStore: MiddlewareHandler<AuthContext> = async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  await next();
};

export const createDocumentMarkdownRoutes = (dependencies: DocumentMarkdownRouteDependencies = {}) => {
  const authenticate = dependencies.authenticate ?? auth.requireRole("authenticated");
  const rateLimiter = dependencies.rateLimiter ?? rateLimit(documentRateLimit);
  const extract = dependencies.extract ?? extractDocumentMarkdown;
  let activeConversions = 0;
  const rejectWhenBusy: MiddlewareHandler<AuthContext> = async (c, next) => {
    if (activeConversions >= DOCUMENT_MARKDOWN_MAX_ACTIVE_CONVERSIONS) {
      return c.json(
        {
          code: "resource_limit" as const,
          message: resolveMessages(c).conversionBusy,
        },
        503,
      );
    }
    await next();
  };
  const reserveConversion: MiddlewareHandler<AuthContext> = async (c, next) => {
    if (activeConversions >= DOCUMENT_MARKDOWN_MAX_ACTIVE_CONVERSIONS) {
      return c.json(
        {
          code: "resource_limit" as const,
          message: resolveMessages(c).conversionBusy,
        },
        503,
      );
    }
    activeConversions += 1;
    try {
      await next();
    } finally {
      activeConversions -= 1;
    }
  };

  return new Hono<AuthContext>().post(
    "/markdown",
    describeRoute({
      tags: ["Tools"],
      summary: "Convert a document to Markdown",
      description:
        "Extracts plain Markdown from one uploaded document of up to 20 MiB with a filename of up to 255 characters. Output is limited to 1 MiB. The upload and result are processed in memory and are not persisted.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(DocumentMarkdownResponseSchema, "Extracted Markdown"),
        400: jsonResponse(DocumentMarkdownErrorSchema, "Invalid multipart request"),
        401: jsonResponse(DocumentMarkdownErrorSchema, "Authentication required"),
        408: jsonResponse(DocumentMarkdownErrorSchema, "Conversion cancelled"),
        413: jsonResponse(DocumentMarkdownErrorSchema, "Document too large"),
        422: jsonResponse(DocumentMarkdownErrorSchema, "Document cannot be extracted"),
        429: jsonResponse(DocumentMarkdownErrorSchema, "Rate limit exceeded"),
        500: jsonResponse(DocumentMarkdownErrorSchema, "Extraction failed"),
        503: jsonResponse(DocumentMarkdownErrorSchema, "Conversion capacity exhausted"),
      },
    }),
    authenticate,
    rateLimiter,
    noStore,
    rejectWhenBusy,
    documentBodyLimit,
    requireBoundedMultipart(),
    v("form", DocumentMarkdownRequestSchema),
    reserveConversion,
    async (c) => {
      const t = resolveMessages(c);
      const file = c.req.valid("form").file;
      if (file.name.length > 255) {
        return c.json({ code: "malformed" as const, message: t.filenameTooLong }, 400);
      }
      if (file.size > DOCUMENT_EXTRACTION_MAX_INPUT_BYTES) {
        return c.json(
          {
            code: "input_too_large" as const,
            message: t.documentTooLarge,
          },
          413,
        );
      }

      try {
        const result = await extract({
          bytes: new Uint8Array(await file.arrayBuffer()),
          filename: file.name,
          signal: c.req.raw.signal,
        });
        return c.json({ filename: file.name, ...result }, 200);
      } catch (cause) {
        const error = documentError(cause, t.extractionFailed);
        return c.json({ code: error.code, message: error.message }, errorStatus(error.code));
      }
    },
  );
};

export default createDocumentMarkdownRoutes();
