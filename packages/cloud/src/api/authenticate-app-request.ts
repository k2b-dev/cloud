import type { SQL } from "bun";
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import { CAPABILITY_MAX_REQUEST_BYTES } from "../contracts/capabilities";
import { clientIpBucket } from "../server/client-ip";
import { type RateLimitResult, ratelimit } from "../server/ratelimit";
import { REQUEST_IDLE_TIMEOUT_SECONDS } from "../server/request-timeout";
import {
  authenticateAppProof,
  BootstrapProofError,
  bootstrapRateLimit,
  consumeBootstrapProof,
  inspectAppProof,
} from "../services/app-bootstrap";
import { touchAppKey } from "../services/app-keys";
import type { AuthenticatedWorkload } from "../services/identity/workload-auth";

type Dependencies = {
  /** Trusted route-owned body budget; defaults to the capability request budget. */
  maxBodyBytes?: number;
  db?: SQL;
  ingress?: (peer: string) => Promise<RateLimitResult>;
  admit?: (keyId: string, appId: string) => Promise<RateLimitResult>;
};
const admission = async (kind: "ingress" | "key", id: string) =>
  ratelimit({ id: `app-bootstrap-${kind}`, limit: await bootstrapRateLimit() }).check(id);

/** Core-only request authentication; the body remains available to the domain handler. */
export const authenticateSignedAppRequest = async (
  c: Context,
  scope: "identity:invoke" | "oauth:issue",
  dependencies: Dependencies = {},
): Promise<AuthenticatedWorkload | Response> => {
  c.header("Cache-Control", "no-store");
  const deadline = AbortSignal.timeout(REQUEST_IDLE_TIMEOUT_SECONDS * 1000);
  const signal = AbortSignal.any([c.req.raw.signal, deadline]);
  const reject = (status: 401 | 403 | 413 | 429 | 503 | 504, code: string, message: string) => c.json({ code, message }, status);
  const limited = (rate: RateLimitResult) => {
    c.header("Retry-After", String(Math.max(1, Math.ceil(rate.resetIn / 1000))));
    return reject(429, "RATE_LIMITED", "App request admission limit reached");
  };
  try {
    let peer = "unknown";
    try {
      peer = getConnInfo(c).remote.address ?? peer;
    } catch {
      /* In-process requests have no socket. */
    }
    const ingress = await (dependencies.ingress ?? ((id) => admission("ingress", id)))(clientIpBucket(peer));
    if (ingress.limited) return limited(ingress);
    const header = c.req.header("Authorization") ?? "";
    if (!header.startsWith("Bearer ")) return reject(401, "invalid_proof", "A valid app proof is required");
    inspectAppProof(header.slice(7));
    const maxBodyBytes = dependencies.maxBodyBytes ?? CAPABILITY_MAX_REQUEST_BYTES;
    const tooLarge = () => reject(413, "body_too_large", "App request exceeds the byte limit");
    if (Number(c.req.header("Content-Length")) > maxBodyBytes) {
      void c.req.raw.body?.cancel().catch(() => undefined);
      return tooLarge();
    }
    signal.throwIfAborted();
    const copy = c.req.raw.clone();
    const reader = copy.body?.getReader();
    let bytes = new Uint8Array(Math.min(4096, maxBodyBytes));
    let total = 0;
    if (reader) {
      const cancel = () => {
        // A tee cancels its source only after both branches cancel. Never await a stalled source.
        void reader.cancel(signal.reason).catch(() => undefined);
        void c.req.raw.body?.cancel(signal.reason).catch(() => undefined);
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        signal.throwIfAborted();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (total + chunk.value.byteLength > maxBodyBytes) {
            cancel();
            return tooLarge();
          }
          if (total + chunk.value.byteLength > bytes.byteLength) {
            const grown = new Uint8Array(Math.min(maxBodyBytes, Math.max(total + chunk.value.byteLength, bytes.byteLength * 2)));
            grown.set(bytes);
            bytes = grown;
          }
          bytes.set(chunk.value, total);
          total += chunk.value.byteLength;
        }
        signal.throwIfAborted();
      } catch (error) {
        cancel();
        if (signal.aborted) throw signal.reason;
        throw error;
      } finally {
        signal.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
    }
    const url = new URL(c.req.url);
    const verified = await authenticateAppProof(
      header.slice(7),
      { method: c.req.method, path: url.pathname + url.search, body: bytes.slice(0, total) },
      dependencies.db,
    );
    // Recheck the operator-owned key grant on every transmission.
    if (scope === "oauth:issue" && !verified.key.oauthIssueAllowed)
      return reject(403, "scope_not_permitted", "App is not permitted to issue OAuth credentials");
    const declaredApp = c.req.header("X-Cloud-App-Id");
    if (declaredApp && declaredApp !== verified.identity.appId) return reject(403, "wrong_app", "App identity does not match the proof");
    const rate = await (dependencies.admit ?? ((id) => admission("key", id)))(verified.identity.keyId, verified.identity.appId);
    if (rate.limited) return limited(rate);
    if (!(await consumeBootstrapProof(verified.identity.keyId, verified.jti, verified.exp, dependencies.db)))
      return reject(403, "replayed_proof", "App proof has already been used");
    await touchAppKey(verified.identity, dependencies.db);
    return {
      appId: verified.identity.appId,
      keyId: verified.identity.keyId,
      serviceAccountId: verified.key.serviceAccountId,
      credentialId: verified.identity.keyId,
      scope: "identity:invoke",
    };
  } catch (error) {
    if (signal.aborted && error === signal.reason) {
      void c.req.raw.body?.cancel(signal.reason).catch(() => undefined);
      return c.req.raw.signal.aborted
        ? Response.json(
            { code: "REQUEST_CANCELLED", message: "App request was cancelled" },
            { status: 499, headers: { "Cache-Control": "no-store" } },
          )
        : reject(504, "DEADLINE_EXCEEDED", "App request body deadline exceeded");
    }
    if (error instanceof BootstrapProofError)
      return reject(error.code === "invalid_proof" ? 401 : 403, error.code, "App proof was rejected");
    c.header("Retry-After", "1");
    return reject(503, "app_proof_unavailable", "App request authentication is temporarily unavailable");
  }
};
