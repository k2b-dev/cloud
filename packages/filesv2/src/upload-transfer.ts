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

export type UploadTransferKind = "stalled" | "network" | "busy" | "rate_limited" | "server" | "final";
export class UploadTransferError extends Error {
  constructor(
    message: string,
    readonly kind: UploadTransferKind,
    cause: unknown,
    readonly retryAfter?: number,
    readonly origin: "filegate" | "cloud" = "filegate",
    readonly code?: string,
  ) {
    super(message, { cause });
    this.name = "UploadTransferError";
  }
}

/** Both transports use the same outcome table; retry timing belongs to their caller. */
export function uploadFailureKind(status: number): UploadTransferKind {
  if ([408, 502, 503, 504].includes(status)) return "busy";
  if (status === 429) return "rate_limited";
  return status >= 500 && status < 600 ? "server" : "final";
}

export function isTransientUploadFailure(error: unknown): error is UploadTransferError {
  return error instanceof UploadTransferError && error.kind !== "final";
}

function retryAfterMs(headers: Headers): number | undefined {
  const requested = headers.get("Retry-After");
  if (requested === null) return;
  const seconds = Number(requested);
  const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(requested) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

export async function uploadResponseFailure(
  response: { status: number; headers: Headers; json: () => Promise<unknown> },
  fallback: string,
): Promise<UploadTransferError> {
  const kind = uploadFailureKind(response.status);
  const retryAfter = retryAfterMs(response.headers);
  const body = await response.json().catch(() => null);
  const code = typeof body === "object" && body !== null && "code" in body && typeof body.code === "string" ? body.code : undefined;
  const message =
    typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" ? body.message : fallback;
  return new UploadTransferError(
    message,
    kind,
    response,
    kind === "busy" || kind === "rate_limited" ? retryAfter : undefined,
    "cloud",
    code,
  );
}

/** The caller's cancellation is distinct from a control request's own deadline. */
export function uploadRequestFailure(error: unknown, fallback: string, signal: AbortSignal): unknown {
  if (signal.aborted) throw error;
  if (error instanceof UploadTransferError) return error;
  if (error instanceof DOMException && error.name === "TimeoutError")
    return new UploadTransferError(fallback, "stalled", error, undefined, "cloud");
  if (error instanceof TypeError || (typeof navigator !== "undefined" && navigator.onLine === false))
    return new UploadTransferError(fallback, "network", error, undefined, "cloud");
  return error;
}

// Cloud no longer holds a usable session for these answers, so there is nothing to abort.
const CLOSED_CODES = ["upload_closed", "receipt_unknown", "upload_changed"];
// Filegate refused publication, so the sent commit is not ambiguous and the session is still open.
const PUBLICATION_CONFLICTS = ["write_conflict", "path_conflict"];

/**
 * What an adapter does with its Filegate session and resume key after a failure: `keep` both so a retry resumes,
 * `drop` the key, or `abort` the session and drop the key once the abort is confirmed.
 * Only an explicit cancel or a final answer ends a session, and a sent commit is never aborted unless Filegate refused publication.
 */
export function uploadFailureAction(
  error: unknown,
  state: { session?: Pick<UploadSession, "state">; committing: boolean; cancelled: boolean },
): "keep" | "drop" | "abort" {
  const open = state.session?.state === "open";
  if (state.cancelled) return open && !state.committing ? "abort" : "keep";
  if (isTransientUploadFailure(error)) return "keep";
  const final = error instanceof UploadTransferError ? error : undefined;
  // Before the session exists, only a final answer proves that the key opened nothing; a lost response stays safe.
  if (!state.session) return final ? "drop" : "keep";
  if (state.committing) {
    if (!final) return "keep";
    return open && PUBLICATION_CONFLICTS.includes(final.code ?? "") ? "abort" : "drop";
  }
  if (final?.origin === "cloud" && CLOSED_CODES.includes(final.code ?? "")) return "drop";
  return open ? "abort" : "keep";
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
        retryAfter = retryAfterMs(response.headers);
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
      if (error instanceof UploadTransferError) throw error;
      if (deadlineExpired.signal.aborted) throw new UploadTransferError(options.failure, "stalled", deadlineExpired.signal.reason);
      // No second transport retry loop: SDK honors Retry-After, cancellation and replayability.
      if (!(error instanceof FilegateError && error.status === 401 && error.code === "expired_capability") || renewals >= 3) {
        const kind =
          error instanceof FilegateError
            ? uploadFailureKind(error.status)
            : (error instanceof TypeError && error === networkError) || (typeof navigator !== "undefined" && navigator.onLine === false)
              ? "network"
              : "final";
        throw new UploadTransferError(
          options.failure,
          kind,
          error,
          kind === "busy" || kind === "rate_limited" ? retryAfter : undefined,
          "filegate",
          error instanceof FilegateError ? error.code : undefined,
        );
      }
      renewals++;
      url = (await options.renew(session.id, AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]))).url;
    }
  }
}
