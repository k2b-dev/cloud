import { apiClient } from "@k2b/cloud/clients/core";
import type { z } from "zod";

export const approvalApi = apiClient.auth["app-approval"].v1;
// UI network budget: stalled requests must not hold a five-minute flow forever.
export const approvalRequestOptions = (signal?: AbortSignal) => ({
  init: { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) },
});
export class ApprovalError extends Error {
  constructor(
    public code: string,
    public status: number,
    public retryAfter = 5,
  ) {
    super(code);
  }
}
type ApprovalResponse = Pick<Response, "json" | "ok" | "status" | "headers">;

export async function checked<T extends ApprovalResponse>(response: T): Promise<T> {
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const code = body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : "UNAVAILABLE";
    const retryAfter = Number(response.headers.get("Retry-After"));
    throw new ApprovalError(code, response.status, Number.isFinite(retryAfter) ? Math.max(5, retryAfter) : 5);
  }
  return response;
}
export async function parsed<T>(response: ApprovalResponse, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await (await checked(response)).json());
}

/**
 * One foreground request at a time. Requests start at least `seconds` apart, so a server that
 * holds a read until something changes is asked again without a gap; `immediate` sends the
 * first read at once. Hidden tabs pause and resume on return. No mutation retries; disposal
 * aborts reads.
 */
export function pollApproval(
  read: (signal: AbortSignal) => Promise<boolean>,
  failed: (error: unknown) => boolean,
  seconds = 5,
  { immediate = false } = {},
) {
  const abort = new AbortController();
  const interval = Math.max(5, seconds) * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let delay = interval;
  let startedAt = immediate ? Number.NEGATIVE_INFINITY : Date.now();
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(tick, Math.max(0, startedAt + delay - Date.now()));
  };
  const tick = async () => {
    timer = undefined;
    if (abort.signal.aborted || running || document.visibilityState === "hidden") return;
    running = true;
    startedAt = Date.now();
    try {
      if (!(await read(abort.signal))) return abort.abort();
      delay = interval;
    } catch (error) {
      if (abort.signal.aborted || !failed(error)) return abort.abort();
      delay = Math.max(Math.min(delay * 2, 60_000), error instanceof ApprovalError ? error.retryAfter * 1000 : 0);
    } finally {
      running = false;
    }
    if (!abort.signal.aborted) schedule();
  };
  const resume = () => {
    if (document.visibilityState !== "hidden" && !running && !timer && !abort.signal.aborted) schedule();
  };
  document.addEventListener("visibilitychange", resume, { signal: abort.signal });
  schedule();
  return () => {
    abort.abort();
    clearTimeout(timer);
  };
}
