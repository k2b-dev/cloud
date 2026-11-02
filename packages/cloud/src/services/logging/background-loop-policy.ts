import type { SyncEvent } from "@k2b/sync";

// Same budget as the Sync trace observer. Declarations are static, never one per entity/run.
// If the budget is exhausted, keep ordinary tracing rather than hiding diagnostics.
const LIMIT = 1024;
const loops = new Set<string>();
export type BackgroundLoop = { kind: "job" | "scheduler"; resource: string; key?: string };
const identity = (loop: BackgroundLoop) => JSON.stringify([loop.kind, loop.resource, loop.key ?? null]);
export const registerBackgroundLoop = (loop: BackgroundLoop): boolean => {
  const id = identity(loop);
  if (!loops.has(id) && loops.size >= LIMIT) return false;
  loops.add(id);
  return true;
};
export const isBackgroundLoopEvent = (event: SyncEvent): boolean => {
  if ((event.kind !== "job" && event.kind !== "scheduler") || !event.resource) return false;
  return loops.has(
    identity({
      kind: event.kind,
      resource: event.resource,
      key: event.kind === "scheduler" && typeof event.detail?.key === "string" ? event.detail.key : undefined,
    }),
  );
};
