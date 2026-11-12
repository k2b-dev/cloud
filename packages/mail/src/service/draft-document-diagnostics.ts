import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";

/** Opt-in, payload-free timings. No subscriber means no tracing or retained edit map. */
export const draftDocumentDiagnostics = channel("cloud.mail.draft-document");
type Context = { updateId: string; peerId: string; role: string };
const context = new AsyncLocalStorage<Context>();
export const draftUpdateId = (payload: string) => Bun.hash(Buffer.from(payload, "base64")).toString(16);
export const draftTraceContext = (payload: string, peerId: string, role: string): Context | undefined =>
  draftDocumentDiagnostics.hasSubscribers ? { updateId: draftUpdateId(payload), peerId, role } : undefined;
export const draftTrace = (stage: string, details: Record<string, unknown> = {}, explicit = context.getStore()) => {
  if (draftDocumentDiagnostics.hasSubscribers)
    draftDocumentDiagnostics.publish({ at: performance.timeOrigin + performance.now(), stage, ...explicit, ...details });
};
export const withDraftTrace = <T>(scope: Context | undefined, operation: () => T): T =>
  scope ? context.run(scope, operation) : operation();
export const draftTraceSpan = async <T>(stage: string, operation: () => Promise<T>): Promise<T> => {
  if (!draftDocumentDiagnostics.hasSubscribers) return operation();
  const start = performance.now();
  draftTrace(`${stage}:start`);
  try {
    return await operation();
  } finally {
    draftTrace(`${stage}:end`, { durationMs: performance.now() - start });
  }
};
export const draftTraceError = (error: unknown, source: string) =>
  draftTrace("failure", {
    source,
    error:
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack, ...("code" in error ? { code: error.code } : {}) }
        : String(error),
  });
