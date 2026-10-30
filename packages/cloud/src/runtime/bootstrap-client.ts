import type { AppKey } from "../app-key";
import {
  BOOTSTRAP_ATTEMPT_MS,
  BOOTSTRAP_BODY,
  BOOTSTRAP_BUDGET_MS,
  BOOTSTRAP_PATH,
  BOOTSTRAP_RESPONSE_BYTES,
  type BootstrapResponse,
  BootstrapResponseSchema,
  signBootstrapProof,
} from "./bootstrap-protocol";

export class BootstrapError extends Error {
  constructor(
    readonly kind: "transient" | "permanent",
    readonly reason: string,
    readonly retryAfterMs = 0,
  ) {
    super(`Core bootstrap ${kind}: ${reason}`);
    this.name = "BootstrapError";
  }
}

const originUrl = (origin: string | undefined): URL => {
  try {
    if (!origin) throw new Error();
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new Error();
    return new URL(BOOTSTRAP_PATH, url);
  } catch {
    throw new BootstrapError("permanent", "CLOUD_CORE_INTERNAL_ORIGIN must be a direct http(s) Core origin");
  }
};
const httpReason = (status: number): string => {
  if (status === 401) return "HTTP 401: unknown, revoked, expired or invalid app key/proof";
  if (status === 403) return "HTTP 403: connections_not_permitted, app/installation mismatch or replayed proof";
  if (status === 404) return "HTTP 404: bootstrap route unavailable; check the direct Core origin and version";
  return `HTTP ${status}`;
};
const retryAfter = (header: string | null, now: number): number => {
  if (!header) return 0;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
};
// Keep transport read failures separate from invalid JSON: only transport failures retry.
const readResponse = async (response: Response, signal: AbortSignal): Promise<unknown> => {
  const tooLarge = () => new BootstrapError("permanent", "response too_large");
  if (Number(response.headers.get("Content-Length")) > BOOTSTRAP_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new BootstrapError("permanent", "response invalid_json");
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const bytes = new Uint8Array(BOOTSTRAP_RESPONSE_BYTES);
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (length + chunk.value.byteLength > bytes.byteLength) {
        void reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      bytes.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  signal.throwIfAborted();
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } catch {
    throw new BootstrapError("permanent", "response invalid_json");
  }
};
// Dependency injection keeps retry-budget tests fast and deterministic; not a public startup option.
type Dependencies = {
  fetch: (url: URL, init: RequestInit) => Promise<Response>;
  now: () => number;
  wallNow: () => number;
  sleep: (ms: number) => Promise<unknown>;
  random: () => number;
  log: (entry: { appId: string; attempt: number; errorClass: "transient" | "permanent" }) => void;
};
const defaults: Dependencies = {
  fetch: (url, init) => fetch(url, init),
  now: () => performance.now(),
  wallNow: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
  random: Math.random,
  log: (entry) => console.warn("Core bootstrap attempt failed", entry),
};

/** No application imports or listeners exist while this bounded startup request waits. */
export const bootstrapConnections = async (
  key: AppKey,
  origin: string | undefined,
  dependencies: Partial<Dependencies> = {},
): Promise<BootstrapResponse> => {
  const url = originUrl(origin);
  const deps = { ...defaults, ...dependencies };
  const deadline = deps.now() + BOOTSTRAP_BUDGET_MS;
  let attempt = 0;
  while (deps.now() < deadline) {
    attempt++;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failure: BootstrapError;
    let httpFailure: BootstrapError | undefined;
    try {
      const transmission = async (): Promise<BootstrapResponse> => {
        const proof = await signBootstrapProof(key, deps.wallNow()).catch(() => {
          throw new BootstrapError("permanent", "could not create Ed25519 startup proof");
        });
        controller.signal.throwIfAborted();
        const response = await deps.fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${proof}`, "Content-Type": "application/json", Accept: "application/json" },
          body: BOOTSTRAP_BODY,
          redirect: "error",
          signal: controller.signal,
        });
        if (response.status !== 200) {
          // A failed transmission may already have consumed its jti.
          httpFailure = new BootstrapError(
            response.status === 429 || response.status === 503 ? "transient" : "permanent",
            httpReason(response.status),
            retryAfter(response.headers.get("retry-after"), deps.wallNow()),
          );
          if (response.status === 403) {
            try {
              // Recognize only the stable permission code; never retain or log raw error payloads.
              const body = await readResponse(response, controller.signal);
              if (typeof body === "object" && body !== null && "code" in body && body.code === "connections_not_permitted")
                httpFailure = new BootstrapError("permanent", "HTTP 403: connections_not_permitted; this key cannot receive connections");
            } catch {
              // A broken or stalled error body cannot turn a permanent HTTP status into a retry.
            }
          } else void response.body?.cancel().catch(() => undefined);
          throw httpFailure;
        }
        const parsed = await readResponse(response, controller.signal);
        const checked = BootstrapResponseSchema.safeParse(parsed);
        if (!checked.success) throw new BootstrapError("permanent", "invalid response schema");
        const { identity } = checked.data;
        if (identity.installationId !== key.installationId) throw new BootstrapError("permanent", "wrong installation");
        if (identity.appId !== key.appId) throw new BootstrapError("permanent", "wrong app");
        if (identity.keyId !== key.keyId) throw new BootstrapError("permanent", "wrong key");
        return checked.data;
      };
      return await Promise.race([
        transmission(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              controller.abort();
              reject(new BootstrapError("transient", "attempt deadline exceeded"));
            },
            Math.min(BOOTSTRAP_ATTEMPT_MS, Math.max(0, deadline - deps.now())),
          );
        }),
      ]);
    } catch (error) {
      // Network/TLS/CA errors may embed credentials or destinations; never retain their text or cause.
      failure = httpFailure ?? (error instanceof BootstrapError ? error : new BootstrapError("transient", "network or TLS failure"));
      deps.log({ appId: key.appId, attempt, errorClass: failure.kind });
      if (failure.kind === "permanent") throw failure;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    // Full jitter, capped at the per-attempt deadline. Retry-After remains a minimum wait.
    const delay = Math.max(failure.retryAfterMs, deps.random() * Math.min(BOOTSTRAP_ATTEMPT_MS, 250 * 2 ** Math.min(attempt - 1, 6)));
    const remaining = deadline - deps.now();
    if (delay >= remaining) break;
    await deps.sleep(delay);
  }
  throw new BootstrapError("transient", "five-minute startup budget exhausted");
};
