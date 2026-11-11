import {
  type GotenbergConfig,
  GotenbergRenderError,
  getGotenbergConfig,
  pdfToolLimits,
  runPdfToolWithConfig,
} from "@k2b/cloud/services/pdf";
import { readBoundedBody } from "../bounded-body";
import type { EntryResult } from "../contracts";
import { type PdfEvent, PdfInputSchema } from "../pdf-contracts";
import type { UserFilesCall } from "./activity";
import { FilesError } from "./errors";
import { strictName, userPath } from "./paths";

export class FilesPdfError extends FilesError {
  constructor(
    code: string,
    readonly path?: string,
  ) {
    super(code, code === "pdf_not_configured" || code === "pdf_busy" ? 503 : code === "pdf_changed" ? 409 : 400);
  }
}

export function pdfError(error: unknown, paths: string[]): FilesError {
  if (error instanceof FilesError) return error.code === "preview_too_large" ? new FilesPdfError("pdf_too_large") : error;
  if (error instanceof GotenbergRenderError) {
    const path = error.fileIndex === undefined ? (paths.length === 1 ? paths[0] : undefined) : paths[error.fileIndex];
    switch (error.code) {
      case "encrypted_pdf":
        return new FilesPdfError("pdf_encrypted", path);
      case "unreadable_pdf":
        return new FilesPdfError("pdf_unreadable", path);
      case "bad_input":
        return new FilesPdfError("invalid_input");
      case "pdf_too_large":
      case "html_too_large":
        return new FilesPdfError("pdf_too_large");
      case "not_configured":
        return new FilesPdfError("pdf_not_configured");
      case "bad_response":
        if (error.status === 400 || error.status === 422) return new FilesPdfError("pdf_unreadable", path);
    }
  }
  return new FilesPdfError("pdf_failed");
}

type Dependencies = {
  source(
    call: UserFilesCall,
    baseId: string,
    path: string,
    signal: AbortSignal,
  ): Promise<{
    size: number;
    /** The version this check saw; `read` refuses a source that changed since. */
    revision?: string;
    read(signal: AbortSignal): Promise<Response>;
  }>;
  destination(call: UserFilesCall, baseId: string, path: string, signal: AbortSignal): Promise<void>;
  save(call: UserFilesCall, baseId: string, path: string, bytes: Uint8Array, signal: AbortSignal): Promise<EntryResult>;
  config?: () => Promise<GotenbergConfig>;
  run?: typeof runPdfToolWithConfig;
};

/**
 * Sources are read whole into memory before the renderer sees them, so at most two PDF actions run in this process
 * and one per person, as the Tools PDF route admits. A further request answers "busy" before reading any byte.
 */
const PDF_ACTIONS_PER_PROCESS = 2;
const activePdfSubjects = new Set<string>();
const admitPdfAction = (subject: string): (() => void) => {
  if (activePdfSubjects.size >= PDF_ACTIONS_PER_PROCESS || activePdfSubjects.has(subject)) throw new FilesPdfError("pdf_busy");
  activePdfSubjects.add(subject);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activePdfSubjects.delete(subject);
  };
};

/** All source stats and destination rights are checked before the first byte read. */
export function createPdfOperation(deps: Dependencies) {
  return async (call: UserFilesCall, baseId: string, raw: unknown, requestSignal: AbortSignal) => {
    const parsed = PdfInputSchema.safeParse(raw);
    if (!parsed.success) throw new FilesError("invalid_input");
    const input = parsed.data;
    strictName(input.name);
    input.paths.forEach(userPath);
    requestSignal.throwIfAborted();
    const config = await (deps.config ?? getGotenbergConfig)();
    const limits = pdfToolLimits(config);
    if (!config.url.trim()) throw new FilesPdfError("pdf_not_configured");
    if (input.paths.length > limits.maxFiles || new TextEncoder().encode(JSON.stringify(input)).length > limits.maxMetadataBytes)
      throw new FilesPdfError("pdf_too_large");
    if (input.operation === "extract") {
      if (input.pages.length > limits.maxPages || input.pages.some((page) => page > limits.maxPages))
        throw new FilesPdfError("pdf_too_large");
      if (input.pages.some((page, index) => index > 0 && page <= input.pages[index - 1]!)) throw new FilesError("invalid_input");
      if (input.revisions.length !== input.paths.length) throw new FilesError("invalid_input");
    }
    if (input.revisions && input.revisions.length !== input.paths.length) {
      throw new FilesError("invalid_input");
    }
    const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(config.timeoutMs)]);
    const path = [...input.paths[0]!.split("/").slice(0, -1), input.name].join("/");
    if (path.length > 4096) throw new FilesError("invalid_path");
    await deps.destination(call, baseId, path, signal);
    const sources: Awaited<ReturnType<Dependencies["source"]>>[] = [];
    let size = 0;
    for (const path of input.paths) {
      signal.throwIfAborted();
      if (!/\.pdf$/i.test(path)) throw new FilesPdfError("pdf_unreadable", path);
      const source = await deps.source(call, baseId, path, signal);
      if (!Number.isSafeInteger(source.size) || source.size < 5) throw new FilesPdfError("pdf_unreadable", path);
      size += source.size;
      if (size > limits.maxInputBytes) throw new FilesPdfError("pdf_too_large");
      // The person chose pages of the version they saw; a newer version would shift them.
      const seen = input.revisions?.[sources.length];
      if (seen !== undefined && source.revision !== undefined && seen !== source.revision) throw new FilesPdfError("pdf_changed", path);
      sources.push(source);
    }
    return {
      timeoutMs: config.timeoutMs,
      async run(emit: (event: PdfEvent) => Promise<void>, streamSignal: AbortSignal): Promise<void> {
        const release = admitPdfAction(JSON.stringify(call.accessSubject ?? call.actor));
        try {
          await work(emit, streamSignal);
        } finally {
          release();
        }
      },
    };
    async function work(emit: (event: PdfEvent) => Promise<void>, streamSignal: AbortSignal): Promise<void> {
      const workSignal = AbortSignal.any([signal, streamSignal]);
      const total = sources.length + (input.operation === "extract" && sources.length > 1 ? 2 : 1) + 1;
      let done = 0;
      await emit({ type: "progress", done, total });
      const files: Blob[] = [];
      let bytesRead = 0;
      for (const [index, source] of sources.entries()) {
        workSignal.throwIfAborted();
        const bytes = new Uint8Array(await readBoundedBody(await source.read(workSignal), limits.maxInputBytes - bytesRead, workSignal));
        bytesRead += bytes.length;
        if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new FilesPdfError("pdf_unreadable", input.paths[index]);
        files.push(new Blob([bytes], { type: "application/pdf" }));
        await emit({ type: "progress", done: ++done, total });
      }
      const result = await (deps.run ?? runPdfToolWithConfig)(
        { files, operation: input.operation === "merge" ? { kind: "merge" } : { kind: "extract", pages: input.pages } },
        config,
        {
          signal: workSignal,
          onOperation: async () => {
            await emit({ type: "progress", done: ++done, total });
          },
        },
      );
      workSignal.throwIfAborted();
      const saved = await deps.save(call, baseId, path, result.data, workSignal);
      await emit({ type: "progress", done: total, total });
      await emit({ type: "done", result: saved });
    }
  };
}
