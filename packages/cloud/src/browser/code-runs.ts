import { invokeCapabilityWithDataSchema } from "../capabilities/client";
import { applyCodeOutputEvent, type CodeOutputWindow } from "../code/output";
import { CodeRunEntriesInputSchema, CodeRunEntriesSchema, CodeRunLiveEventSchema, type CodeRunEntries } from "../code/run-ledger";
import { liveConnection } from "./live";

/** Browser query for the permission-aware Core run-output service also used by SSR. */
export function readCodeRunEntries(scope: { codeId: string; runId: string }, signal?: AbortSignal) {
  return invokeCapabilityWithDataSchema({
    appId: "core", capabilityId: "code.run.entries", kind: "query",
    input: CodeRunEntriesInputSchema.parse(scope), ...(signal ? { signal } : {}),
  }, CodeRunEntriesSchema);
}

/** One run on the existing Core socket. Admission checks management rights;
 * ordinary output applies locally, without a read. Admission, replay gaps and
 * the terminal transition load one covering tail through the same authorized query.
 * Dispose with the owning island. A failure is reported to the host visibly.
 */
export function followCodeRun(
  scope: { codeId: string; runId: string },
  options: {
    initial: CodeRunEntries;
    snapshot: (signal: AbortSignal) => Promise<CodeRunEntries>;
    apply: (snapshot: CodeRunEntries) => void;
    unavailable: (reason: "revoked" | "unavailable") => void;
  },
): () => void {
  CodeRunEntriesInputSchema.parse(scope);
  let current = options.initial;
  let closed = false;
  let admitted = false;
  let refreshing: Promise<void> | undefined;
  const abort = new AbortController();
  let dispose = () => {};
  const refresh = () => {
    if (closed) return Promise.resolve();
    admitted = true;
    refreshing ??= options.snapshot(abort.signal).then((snapshot) => {
      if (closed) return;
      current = snapshot;
      options.apply(current);
    }).finally(() => { refreshing = undefined; });
    return refreshing;
  };
  const fail = (reason: "revoked" | "unavailable") => {
    if (closed) return;
    closed = true;
    abort.abort();
    dispose();
    options.unavailable(reason);
  };
  const subscription = liveConnection("/api/ai/live").subscribe("codeRun", scope, {
    cursor: null,
    parse: (raw) => CodeRunLiveEventSchema.parse(raw),
    apply: async (events) => {
      if (refreshing) await refreshing;
      for (const { data } of events) {
        if (closed || data.runId !== scope.runId) continue;
        if (data.type === "code.run") {
          if (["succeeded", "failed", "cancelled", "skipped"].includes(data.state)) await refresh();
          else if (current.state === "queued" || current.state === "running") {
            current = { ...current, state: data.state, ...(data.state === "running" && !current.startedAt ? { startedAt: data.at } : {}) };
            options.apply(current);
          }
          continue;
        }
        const output: CodeOutputWindow | null = current.output;
        if (!output) continue;
        if (data.generation < output.generation || (data.generation === output.generation && data.seq <= output.seq)) continue;
        if (data.generation !== output.generation || data.seq !== output.seq + 1) { await refresh(); continue; }
        current = { ...current, output: applyCodeOutputEvent(output, data) };
        options.apply(current);
      }
    },
    resync: refresh,
    caughtUp: (ready) => {
      if (!ready || admitted || closed) return;
      admitted = true;
      void refresh().catch(() => fail("unavailable"));
    },
    revoked: () => fail("revoked"),
    unavailable: () => fail("unavailable"),
  });
  dispose = () => subscription.close();
  return () => { closed = true; abort.abort(); subscription.close(); };
}
