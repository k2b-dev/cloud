import type { SQL } from "bun";
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import { CAPABILITY_MAX_REQUEST_BYTES } from "../contracts/capabilities";
import { clientIpBucket } from "../server/client-ip";
import { type RateLimitResult, ratelimit } from "../server/ratelimit";
import { authenticateAppProof, BootstrapProofError, bootstrapRateLimit, consumeBootstrapProof } from "../services/app-bootstrap";
import { touchAppKey } from "../services/app-keys";
import type { AuthenticatedWorkload } from "../services/identity/workload-auth";

type Dependencies = {
  db?: SQL;
  ingress?: (peer: string) => Promise<RateLimitResult>;
  admit?: (keyId: string) => Promise<RateLimitResult>;
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
  const reject = (status: 401 | 403 | 413 | 429 | 503, code: string) => c.json({ code }, status);
  const limited = (rate: RateLimitResult) => {
    c.header("Retry-After", String(Math.max(1, Math.ceil(rate.resetIn / 1000))));
    return reject(429, "app_proof_rate_limited");
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
    if (!header.startsWith("Bearer ")) return reject(401, "invalid_proof");
    if (Number(c.req.header("Content-Length")) > CAPABILITY_MAX_REQUEST_BYTES) return reject(413, "body_too_large");
    const copy = c.req.raw.clone();
    const reader = copy.body?.getReader();
    const bytes = new Uint8Array(CAPABILITY_MAX_REQUEST_BYTES);
    let total = 0;
    if (reader) {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (total + chunk.value.byteLength > bytes.byteLength) {
            void reader.cancel().catch(() => undefined);
            void c.req.raw.body?.cancel().catch(() => undefined);
            return reject(413, "body_too_large");
          }
          bytes.set(chunk.value, total);
          total += chunk.value.byteLength;
        }
      } finally {
        reader.releaseLock();
      }
    }
    const url = new URL(c.req.url);
    const verified = await authenticateAppProof(
      header.slice(7),
      { method: c.req.method, path: url.pathname + url.search, body: bytes.slice(0, total) },
      dependencies.db,
    );
    // App-key capabilities are policy, not mutable copies of service-account grants.
    if (scope === "oauth:issue" && verified.identity.appId !== "oauth") return reject(403, "scope_not_permitted");
    const declaredApp = c.req.header("X-Cloud-App-Id");
    if (declaredApp && declaredApp !== verified.identity.appId) return reject(403, "wrong_app");
    const rate = await (dependencies.admit ?? ((id) => admission("key", id)))(verified.identity.keyId);
    if (rate.limited) return limited(rate);
    if (!(await consumeBootstrapProof(verified.identity.keyId, verified.jti, verified.exp, dependencies.db)))
      return reject(403, "replayed_proof");
    await touchAppKey(verified.identity, dependencies.db);
    return {
      appId: verified.identity.appId,
      serviceAccountId: verified.key.serviceAccountId,
      credentialId: verified.identity.keyId,
      scope: "identity:invoke",
    };
  } catch (error) {
    if (error instanceof BootstrapProofError) return reject(error.code === "invalid_proof" ? 401 : 403, error.code);
    c.header("Retry-After", "1");
    return reject(503, "app_proof_unavailable");
  }
};
