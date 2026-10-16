import { DirectSession, FilegateError } from "@k2b/filegate/utils";
import type { UploadSession } from "./contracts";

// Tiny control requests get margin for a commit holding Filegate's root lock.
const CONTROL_DEADLINE = 30_000;
// Match Cloud's 60 s control-call budget for fsync and lock waits.
const PUT_BASE_DEADLINE = 60_000;
// Browser fetch cannot observe request-body bytes, so a size-proportional deadline replaces an inactivity timer.
// 64 KiB/s (about 0.5 Mbit/s) is the slowest supported uplink.
const MIN_UPLOAD_BYTES_PER_SECOND = 64 * 1024;
const requestDeadline = (init?: RequestInit) => {
  if (init?.method !== "PUT") return CONTROL_DEADLINE;
  const body = init.body;
  const bytes =
    body instanceof Blob
      ? body.size
      : body instanceof ArrayBuffer || ArrayBuffer.isView(body)
        ? body.byteLength
        : typeof body === "string"
          ? new TextEncoder().encode(body).byteLength
          : 0;
  return PUT_BASE_DEADLINE + (bytes / MIN_UPLOAD_BYTES_PER_SECOND) * 1000;
};

export type UploadTransferKind = "stalled" | "network" | "busy" | "final";
export class UploadTransferError extends Error {
  constructor(
    message: string,
    readonly kind: UploadTransferKind,
    cause: unknown,
    readonly retryAfter?: number,
  ) {
    super(message, { cause });
    this.name = "UploadTransferError";
  }
}

/** Cloud bounds requests and renews authorization; Filegate owns paging, verification and transport retries. */
export async function transferUpload(
  file: Blob,
  session: UploadSession,
  options: {
    signal: AbortSignal;
    renew: (id: string, signal: AbortSignal) => Promise<{ url: string }>;
    onProgress?: (bytes: number) => void;
    failure: string;
  },
): Promise<void> {
  options.signal.throwIfAborted();
  if (session.state === "committed") return;
  if (session.state !== "open" || !session.url)
    throw new UploadTransferError(options.failure, "final", new Error("Session is not open or has no URL"));
  let url = session.url;
  let renewals = 0;
  let progress = -1;
  const deadlineExpired = new AbortController();
  const transferSignal = AbortSignal.any([options.signal, deadlineExpired.signal]);
  let retryAfter: number | undefined;
  let networkError: TypeError | undefined;
  const request: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      options.signal.throwIfAborted();
      init?.signal?.throwIfAborted();
      const deadline = AbortSignal.timeout(requestDeadline(init));
      const signal = AbortSignal.any(init?.signal ? [init.signal, deadline] : [deadline]);
      const expire = () => deadlineExpired.abort(deadline.reason);
      deadline.addEventListener("abort", expire, { once: true });
      if (deadline.aborted) expire();
      retryAfter = undefined;
      networkError = undefined;
      try {
        const response = await fetch(input, { ...init, signal });
        const requested = response.headers.get("Retry-After");
        if (requested !== null) {
          const seconds = Number(requested);
          const milliseconds = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(requested) - Date.now();
          if (Number.isFinite(milliseconds)) retryAfter = Math.max(0, milliseconds);
        }
        const body = await response.arrayBuffer().catch((error: unknown) => {
          if (response.ok) throw error;
          return null;
        });
        signal.throwIfAborted();
        return new Response([204, 205, 304].includes(response.status) ? null : body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        options.signal.throwIfAborted();
        if (deadline.aborted) throw deadline.reason;
        if (error instanceof TypeError) networkError = error;
        throw error;
      } finally {
        deadline.removeEventListener("abort", expire);
      }
    },
    { preconnect: fetch.preconnect },
  );
  for (;;) {
    options.signal.throwIfAborted();
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(options.failure);
      const status = await new DirectSession(url, request).upload(file, {
        signal: transferSignal,
        onProgress: (bytes) => {
          if (bytes > progress) {
            renewals = 0;
            progress = bytes;
          }
          options.onProgress?.(bytes);
        },
      });
      if (status.state === "committed") return;
      if (status.state !== "open" || status.received !== file.size) throw new Error(options.failure);
      return;
    } catch (error) {
      options.signal.throwIfAborted();
      if (deadlineExpired.signal.aborted) throw new UploadTransferError(options.failure, "stalled", deadlineExpired.signal.reason);
      // No second transport retry loop: SDK honors Retry-After, cancellation and replayability.
      if (!(error instanceof FilegateError && error.status === 401 && error.code === "expired_capability") || renewals >= 3) {
        const kind: UploadTransferKind =
          error instanceof FilegateError
            ? error.status === 408 || error.status === 429 || error.status >= 500
              ? "busy"
              : "final"
            : error instanceof TypeError && error === networkError
              ? "network"
              : "final";
        throw new UploadTransferError(options.failure, kind, error, kind === "busy" ? retryAfter : undefined);
      }
      renewals++;
      url = (await options.renew(session.id, AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]))).url;
    }
  }
}
