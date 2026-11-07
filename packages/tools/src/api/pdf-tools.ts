import { type AuthContext, auth, getLocale, jsonResponse, rateLimit, requiresAuth, setRequestTimeout } from "@k2b/cloud/server";
import {
  type GotenbergConfig,
  GotenbergRenderError,
  getGotenbergConfig,
  PDF_TOOL_PART_METADATA_BYTES,
  type PdfToolOperation,
  pdfToolLimits,
  runPdfToolWithConfig,
  validatePdfToolInput,
} from "@k2b/cloud/services/pdf";
import { i18n } from "@k2b/stdlib";
import { Hono, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";

export type { PdfToolOperation } from "@k2b/cloud/services/pdf";

// Registry ceiling: 120 seconds / the existing 100 ms minimum renderer timeout.
const pages = z.array(z.number().int().positive()).min(1).max(1200);
export const PdfToolOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("merge") }).strict(),
  z.object({ kind: z.literal("extract"), pages }).strict(),
  z.object({ kind: z.literal("split"), groups: z.array(pages).min(2).max(1200) }).strict(),
  z
    .object({ kind: z.literal("rotate"), angle: z.union([z.literal(90), z.literal(180), z.literal(270)]), pages: pages.optional() })
    .strict(),
  z.object({ kind: z.literal("reorder"), pages }).strict(),
]);

export const PdfToolsErrorSchema = z.object({
  code: z.enum([
    "bad_input",
    "pdf_too_large",
    "cancelled",
    "renderer_busy",
    "renderer_not_configured",
    "renderer_timeout",
    "renderer_rejected",
    "renderer_failed",
  ]),
  message: z.string(),
});
export type PdfToolsError = z.infer<typeof PdfToolsErrorSchema>;
export type PdfToolsErrorCode = PdfToolsError["code"];

type Dependencies = {
  authenticate?: MiddlewareHandler<AuthContext>;
  rateLimiter?: MiddlewareHandler<AuthContext>;
  config?: () => Promise<GotenbergConfig>;
  run?: typeof runPdfToolWithConfig;
};

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      bad_input: "Choose PDF files and valid pages for this operation.",
      pdf_too_large: "The PDF operation exceeds the size, page or work limit. Use fewer pages or smaller files.",
      cancelled: "The PDF operation was cancelled.",
      renderer_busy: "PDF processing is busy. Try again in a moment.",
      renderer_not_configured: "PDF processing is not configured.",
      renderer_timeout: "PDF processing timed out. Use fewer pages or smaller files and try again.",
      renderer_rejected: "The PDF could not be processed. Check that it is readable and not encrypted.",
      renderer_failed: "The PDF renderer could not complete this operation. Try again.",
    },
    de: {
      bad_input: "Wähle PDF-Dateien und gültige Seiten für diese Aktion.",
      pdf_too_large: "Die PDF-Aktion überschreitet die Größen-, Seiten- oder Arbeitsgrenze. Verwende weniger Seiten oder kleinere Dateien.",
      cancelled: "Die PDF-Aktion wurde abgebrochen.",
      renderer_busy: "Die PDF-Verarbeitung ist ausgelastet. Versuche es gleich erneut.",
      renderer_not_configured: "Die PDF-Verarbeitung ist nicht eingerichtet.",
      renderer_timeout:
        "Die PDF-Verarbeitung hat das Zeitlimit überschritten. Versuche es mit weniger Seiten oder kleineren Dateien erneut.",
      renderer_rejected: "Das PDF konnte nicht verarbeitet werden. Prüfe, ob es lesbar und nicht verschlüsselt ist.",
      renderer_failed: "Der PDF-Renderer konnte die Aktion nicht abschließen. Versuche es erneut.",
    },
  },
});

class RequestTooLarge extends Error {}

// Inspect the bounded wire metadata before the runtime's FormData parser.
// Keep the accepted envelope narrow: one operation and PDF file parts only.
function validateMultipart(body: Buffer, contentType: string, limits: ReturnType<typeof pdfToolLimits>): void {
  const boundaryMatch = /^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;\s]+))\s*$/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary || !/^[0-9A-Za-z'()+_,./:=? -]{1,70}$/.test(boundary)) throw new Error("invalid boundary");
  const marker = Buffer.from(`--${boundary}`);
  const separator = Buffer.from(`\r\n--${boundary}`);
  let cursor = 0;
  let metadata = 0;
  let fileBytes = 0;
  let files = 0;
  let operations = 0;
  while (true) {
    if (!body.subarray(cursor, cursor + marker.length).equals(marker)) throw new Error("invalid delimiter");
    cursor += marker.length;
    if (body.subarray(cursor, cursor + 2).toString() === "--") {
      const tail = body.subarray(cursor + 2).toString();
      if ((tail !== "" && tail !== "\r\n") || !files || operations !== 1) throw new Error("invalid multipart end");
      return;
    }
    if (body.subarray(cursor, cursor + 2).toString() !== "\r\n") throw new Error("invalid delimiter");
    cursor += 2;
    const end = body.indexOf("\r\n\r\n", cursor);
    if (end < cursor || end - cursor > limits.maxMetadataBytes - metadata) throw new RequestTooLarge();
    const headers = new Map<string, string>();
    for (const line of body.subarray(cursor, end).toString("utf8").split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon < 1) throw new Error("invalid part header");
      const name = line.slice(0, colon).toLowerCase();
      if (headers.has(name) || (name !== "content-disposition" && name !== "content-type")) throw new Error("invalid part header");
      headers.set(name, line.slice(colon + 1).trim());
    }
    const disposition = /^form-data;\s*name="(files|operation)"(?:;\s*filename="[^"\r\n]*")?$/i.exec(
      headers.get("content-disposition") ?? "",
    );
    if (!disposition) throw new Error("invalid part disposition");
    const next = body.indexOf(separator, end + 4);
    if (next < 0) throw new Error("missing delimiter");
    const length = next - end - 4;
    metadata += end - cursor + marker.length + 8;
    if (disposition[1] === "files") {
      const mime = headers.get("content-type")?.toLowerCase();
      if (mime && mime !== "application/pdf" && mime !== "application/octet-stream") throw new Error("PDF MIME required");
      if (++files > limits.maxFiles) throw new Error("too many files");
      if (!/;\s*filename=/.test(disposition[0])) throw new Error("filename required");
      fileBytes += length;
      if (fileBytes > limits.maxInputBytes) throw new RequestTooLarge();
    } else {
      if (++operations > 1 || /;\s*filename=/.test(disposition[0])) throw new Error("invalid operation field");
      metadata += length;
    }
    if (metadata > limits.maxMetadataBytes) throw new RequestTooLarge();
    cursor = next + 2;
  }
}

/** Always count the actual stream, including requests with a forged Content-Length. */
async function boundedForm(request: Request, limits: ReturnType<typeof pdfToolLimits>, signal: AbortSignal): Promise<FormData> {
  const maxBytes = limits.maxRequestBytes;
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) throw new Error("multipart required");
  if (!request.body) throw new Error("body required");
  const rawLength = request.headers.get("content-length");
  if (rawLength !== null && (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(Number(rawLength)))) throw new Error("invalid length");
  if (rawLength !== null && Number(rawLength) > maxBytes) throw new RequestTooLarge();
  const reader = request.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  let body = Buffer.alloc(Math.min(PDF_TOOL_PART_METADATA_BYTES, maxBytes));
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const item = await reader.read();
      signal.throwIfAborted();
      if (item.done) break;
      const nextSize = size + item.value.length;
      if (nextSize > maxBytes) throw new RequestTooLarge();
      if (nextSize > body.length) {
        const grown = Buffer.alloc(Math.min(maxBytes, Math.max(body.length * 2, nextSize)));
        grown.set(body.subarray(0, size));
        body = grown;
      }
      body.set(item.value, size);
      size = nextSize;
    }
    // FormData sees only a fully bounded body; it never reads the raw stream.
    const bounded = body.subarray(0, size);
    validateMultipart(bounded, request.headers.get("content-type")!, limits);
    return await new Response(bounded, { headers: { "content-type": request.headers.get("content-type")! } }).formData();
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Mount under the authenticated Tools app (app.start supplies app access). */
export const createPdfToolsRoutes = (dependencies: Dependencies = {}) => {
  const authenticate = dependencies.authenticate ?? auth.requireRole("authenticated");
  const rateLimiter = dependencies.rateLimiter ?? rateLimit({ keyBy: "user", limitPerSecond: 4, windowSecs: 10 });
  const getConfig = dependencies.config ?? getGotenbergConfig;
  const run = dependencies.run ?? runPdfToolWithConfig;
  // Match existing Tools document/PDF local memory admission. Shared renderer
  // admission is centralized in the PDF service; neither admission queues.
  let active = 0;
  return new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.header("Cache-Control", "private, no-store");
      c.header("X-Content-Type-Options", "nosniff");
      await next();
    })
    .post(
      "/",
      auth.readOnly,
      describeRoute({
        tags: ["Tools"],
        summary: "Merge, extract, split, rotate or reorder PDF pages",
        ...requiresAuth,
        description:
          "Send multipart files (in merge order) and one JSON operation field. Pages are one-based. Nothing is persisted. Split returns an ordered ZIP; other operations return a PDF.",
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["files", "operation"],
                additionalProperties: false,
                properties: {
                  files: {
                    type: "array",
                    minItems: 1,
                    items: { type: "string", format: "binary" },
                    description: "PDF files in merge order; exactly one for other operations.",
                  },
                  operation: {
                    type: "string",
                    description: 'JSON PdfToolOperation, for example {"kind":"reorder","pages":[3,1,2]}. Pages are one-based.',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Processed PDF or ZIP",
            content: {
              "application/pdf": { schema: { type: "string", format: "binary" } },
              "application/zip": { schema: { type: "string", format: "binary" } },
            },
          },
          400: jsonResponse(PdfToolsErrorSchema, "Invalid operation, files or pages"),
          401: { description: "Authentication required" },
          403: { description: "Tools app access denied" },
          408: jsonResponse(PdfToolsErrorSchema, "Request cancelled"),
          413: jsonResponse(PdfToolsErrorSchema, "Input, page, output or aggregate work budget exceeded"),
          422: jsonResponse(PdfToolsErrorSchema, "PDF could not be processed"),
          429: { description: "Rate limited" },
          502: jsonResponse(PdfToolsErrorSchema, "Renderer failed"),
          503: jsonResponse(PdfToolsErrorSchema, "Renderer busy or unavailable"),
          504: jsonResponse(PdfToolsErrorSchema, "Renderer deadline exceeded"),
        },
      }),
      authenticate,
      rateLimiter,
      async (c) => {
        const requestSignal = c.req.raw.signal;
        let signal = requestSignal;
        const t = messages.resolve([getLocale(c)]).t;
        const failure = (code: PdfToolsErrorCode, status: 400 | 408 | 413 | 422 | 502 | 503 | 504) =>
          c.json({ code, message: t[code] } satisfies PdfToolsError, status);
        if (active >= 2) return failure("renderer_busy", 503);
        active++;
        let raisedTimeout = false;
        try {
          signal.throwIfAborted();
          const config = await getConfig();
          const limits = pdfToolLimits(config);
          signal = AbortSignal.any([requestSignal, AbortSignal.timeout(config.timeoutMs)]);
          setRequestTimeout(c, Math.max(10, Math.ceil(config.timeoutMs / 1000) + 1));
          raisedTimeout = true;
          let form: FormData;
          try {
            form = await boundedForm(c.req.raw, limits, signal);
          } catch (error) {
            if (requestSignal.aborted) return failure("cancelled", 408);
            if (signal.aborted) return failure("renderer_timeout", 504);
            return failure(error instanceof RequestTooLarge ? "pdf_too_large" : "bad_input", error instanceof RequestTooLarge ? 413 : 400);
          }
          const operations = form.getAll("operation");
          if (operations.length !== 1 || typeof operations[0] !== "string") return failure("bad_input", 400);
          for (const name of form.keys()) {
            if (name !== "files" && name !== "operation") return failure("bad_input", 400);
          }
          let operation: PdfToolOperation;
          try {
            operation = PdfToolOperationSchema.parse(JSON.parse(operations[0]));
          } catch {
            return failure("bad_input", 400);
          }
          const files = form.getAll("files");
          if (!files.every((file): file is File => file instanceof File)) return failure("bad_input", 400);
          const input = { files, operation };
          validatePdfToolInput(input, config);
          for (const file of files) {
            signal.throwIfAborted();
            if ((await file.slice(0, 5).text()) !== "%PDF-") return failure("bad_input", 400);
          }
          const result = await run(input, config, { signal });
          signal.throwIfAborted();
          return new Response(new Blob([new Uint8Array(result.data)], { type: result.contentType }), {
            headers: {
              "Cache-Control": "private, no-store",
              "X-Content-Type-Options": "nosniff",
              "Content-Type": result.contentType,
              "Content-Disposition": `attachment; filename="pdf-tools.${result.extension}"`,
              "Content-Length": String(result.data.length),
            },
          });
        } catch (error) {
          if (requestSignal.aborted) return failure("cancelled", 408);
          if (signal.aborted) return failure("renderer_timeout", 504);
          if (error instanceof GotenbergRenderError) {
            switch (error.code) {
              case "bad_input":
                return failure("bad_input", 400);
              case "pdf_too_large":
              case "html_too_large":
                return failure("pdf_too_large", 413);
              case "busy":
                return failure("renderer_busy", 503);
              case "not_configured":
                return failure("renderer_not_configured", 503);
              case "timeout":
                return failure("renderer_timeout", 504);
              case "bad_response":
                if (error.status === 400 || error.status === 422) return failure("renderer_rejected", 422);
            }
          }
          return failure("renderer_failed", 502);
        } finally {
          active--;
          if (raisedTimeout) setRequestTimeout(c, 10);
        }
      },
    );
};
