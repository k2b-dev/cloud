import {
  type AuthContext,
  getLocale,
  middleware,
  REQUEST_IDLE_TIMEOUT_SECONDS,
  requiresAuth,
  setRequestTimeout,
  v,
} from "@k2b/cloud/server";
import { AccountIdentityError } from "@k2b/cloud/services";
import { FilegateError } from "@k2b/filegate";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { stream } from "hono/streaming";
import { requestCall } from "../files-call";
import { type PdfEvent, PdfInputSchema } from "../pdf-contracts";
import { filesService } from "../service";
import { FilesPdfError, pdfError } from "../service/pdf";
import { apiError } from "./api-error";
import { errorMessage, pdfErrorMessage } from "./messages";

export function createPdfApi(prepare: typeof filesService.preparePdf = filesService.preparePdf) {
  return new Hono<AuthContext>().post(
    "/bases/:baseId/pdf",
    middleware.openapi({
      summary: "Merge PDFs or extract pages into a new PDF next to the first source",
      description:
        "Sources remain unchanged. Result names use onConflict=rename. Extract pages are ascending, unique, one-based across the ordered concatenation. Cancellation stops work; a file already committed is retained. Undo uses the existing trash API.",
      ...requiresAuth,
      responses: {
        200: {
          description: "NDJSON progress, followed by exactly one done with EntryResult or error with a localized message",
          content: {
            "application/x-ndjson": {
              schema: {
                type: "string",
                description:
                  'One JSON object per line: {type:"progress",done,total}, {type:"done",result:{base,entry}} or {type:"error",code,message,path?}. Each source read, PDF transformation and save counts as one step.',
              },
            },
          },
        },
      },
    }),
    // Config registry's maximum gotenberg.max_html_bytes; the service applies
    // the operator's actual metadata limit before any file content is read.
    bodyLimit({
      maxSize: 10_485_760,
      onError: (c) => c.json({ ok: false, code: "pdf_too_large", error: errorMessage("pdf_too_large", getLocale(c)) }, 413),
    }),
    v("json", PdfInputSchema),
    async (c) => {
      const input = c.req.valid("json");
      // The renderer's registry ceiling is 120 seconds, including reads/save.
      setRequestTimeout(c, 121);
      let prepared: Awaited<ReturnType<typeof prepare>>;
      try {
        prepared = await prepare(requestCall(c), c.req.param("baseId") ?? "", input, c.req.raw.signal);
      } catch (error) {
        setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
        if (error instanceof FilegateError || error instanceof AccountIdentityError) throw error;
        throw pdfError(error, input.paths);
      }
      setRequestTimeout(c, Math.max(10, Math.ceil(prepared.timeoutMs / 1000) + 1));
      const cancelled = new AbortController();
      c.header("Content-Type", "application/x-ndjson");
      c.header("Cache-Control", "private, no-store");
      c.header("X-Content-Type-Options", "nosniff");
      c.header("X-Accel-Buffering", "no");
      return stream(c, async (writer) => {
        writer.onAbort(() => cancelled.abort());
        const emit = async (event: PdfEvent) => {
          await writer.write(`${JSON.stringify(event)}\n`);
        };
        try {
          await prepared.run(emit, cancelled.signal);
        } catch (error) {
          if (cancelled.signal.aborted || c.req.raw.signal.aborted) return;
          const mapped =
            error instanceof FilegateError || error instanceof AccountIdentityError ? apiError(error) : pdfError(error, input.paths);
          const path = mapped instanceof FilesPdfError ? mapped.path : undefined;
          const code = mapped.code;
          await emit({
            type: "error",
            code,
            message: path ? pdfErrorMessage(code, getLocale(c), path) : errorMessage(code, getLocale(c)),
            ...(path ? { path } : {}),
          });
        } finally {
          setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
        }
      });
    },
  );
}

export const pdfApi = createPdfApi();
