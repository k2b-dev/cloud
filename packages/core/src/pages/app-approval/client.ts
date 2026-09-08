import { apiClient } from "@valentinkolb/cloud/clients/core";
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
export async function checked(response: Response): Promise<Response> {
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const code = body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : "UNAVAILABLE";
    const retryAfter = Number(response.headers.get("Retry-After"));
    throw new ApprovalError(code, response.status, Number.isFinite(retryAfter) ? Math.max(5, retryAfter) : 5);
  }
  return response;
}
export async function parsed<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await (await checked(response)).json());
}

/** One foreground request at a time. No mutation retries; disposal aborts reads. */
export function pollApproval(read: (signal: AbortSignal) => Promise<boolean>, failed: (error: unknown) => boolean, seconds = 5) {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = Math.max(5, seconds) * 1000;
  const tick = async () => {
    if (abort.signal.aborted) return;
    if (document.visibilityState === "hidden") {
      timer = setTimeout(tick, delay);
      return;
    }
    try {
      if (!(await read(abort.signal))) return;
      delay = Math.max(5, seconds) * 1000;
    } catch (error) {
      if (abort.signal.aborted || !failed(error)) return;
      delay = Math.max(Math.min(delay * 2, 60_000), error instanceof ApprovalError ? error.retryAfter * 1000 : 0);
    }
    if (!abort.signal.aborted) timer = setTimeout(tick, delay);
  };
  timer = setTimeout(tick, delay);
  return () => {
    abort.abort();
    clearTimeout(timer);
  };
}
