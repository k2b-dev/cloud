import { z } from "zod";
import { type CodePageCall, type CodePageInvoke, coreQuery, RunReadSchema, wrapped } from "./data";

/** Calls load in batches; "Show more calls" continues. Core returns one call per request. */
export const CODE_PAGE_CALL_BATCH = 20;

/** A short readable line for a call result: an error message, or a compact preview of the returned data. */
export const summarizeCallResult = (result: unknown): string | null => {
  if (result === null || result === undefined) return null;
  if (typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    const error = record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : null;
    const message = typeof error?.message === "string" ? error.message : typeof record.message === "string" ? record.message : null;
    if (message) return message.slice(0, 240);
  }
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
};

const callRefs = (call: unknown): { type: string; id: string }[] => {
  const parsed = z.object({ refs: z.record(z.string(), z.object({ type: z.string(), id: z.string() })) }).safeParse(call);
  return parsed.success ? Object.values(parsed.data.refs) : [];
};

const callTarget = (call: unknown): { type: string; id: string } | null => {
  const parsed = z.object({ target: z.object({ type: z.string(), id: z.string() }) }).safeParse(call);
  return parsed.success ? parsed.data.target : null;
};

/** One batch of calls, read in parallel: a call page starts after the given ordinal. */
export const loadCodeRunCalls = async (
  invoke: CodePageInvoke,
  codeId: string,
  runId: string,
  after: number,
  size = CODE_PAGE_CALL_BATCH,
): Promise<{
  run: z.infer<typeof RunReadSchema>["run"];
  calls: CodePageCall[];
  next: number | null;
  input: unknown;
  inputTooLarge: boolean;
  readable: boolean;
} | null> => {
  const pages = await Promise.all(
    Array.from({ length: size }, (_, index) =>
      invoke(coreQuery("code.run.read", { codeId, runId, cursor: after + index }), wrapped(RunReadSchema)),
    ),
  );
  const first = pages[0];
  if (!first?.ok) return null;
  const contents = first.data.data.data.contents;
  const run = first.data.data.data.run;
  if (!contents) return { run, calls: [], next: null, input: null, inputTooLarge: false, readable: false };
  const calls: CodePageCall[] = [];
  let next: number | null = null;
  for (const page of pages) {
    if (!page.ok || !page.data.data.data.contents) break;
    const call = page.data.data.data.contents.calls[0];
    if (!call) break;
    calls.push({
      ordinal: call.ordinal,
      kind: call.kind,
      capability: call.capability,
      target: callTarget(call.call),
      refs: callRefs(call.call),
      state: call.state,
      summary: summarizeCallResult(call.result),
    });
    next = page.data.data.data.contents.nextCursor;
  }
  return { run, calls, next, input: contents.inputChunked ? null : contents.input, inputTooLarge: contents.inputChunked, readable: true };
};

/** A failed run's classification needs its first action; at most this many batches are read to find it. */
const CLASSIFY_BATCHES = 5;

/**
 * The first calls of a run for its detail. For a failed run, further batches follow until an action appears or the
 * calls end, so "Run again" and "failed before the first call" never depend on what the person expanded.
 */
export const loadCodeRunCallsForDetail = async (invoke: CodePageInvoke, codeId: string, runId: string) => {
  const first = await loadCodeRunCalls(invoke, codeId, runId, 0);
  if (!first || !first.readable || first.run.state !== "failed") return first;
  let result = first;
  for (let batch = 1; batch < CLASSIFY_BATCHES && result.next !== null && !result.calls.some((call) => call.kind === "action"); batch++) {
    const more = await loadCodeRunCalls(invoke, codeId, runId, result.next);
    if (!more) break;
    result = { ...result, calls: [...result.calls, ...more.calls], next: more.next };
  }
  return result;
};
