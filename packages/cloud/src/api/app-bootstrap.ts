import type { SQL } from "bun";
import { Hono, type MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";
import {
  BOOTSTRAP_BODY,
  BOOTSTRAP_PATH,
  BOOTSTRAP_RESPONSE_BYTES,
  BootstrapConnectionsSchema,
  BootstrapResponseSchema,
} from "../runtime/bootstrap-protocol";
import { connections } from "../runtime/connections";
import { clientIpBucket } from "../server/client-ip";
import { type RateLimitResult, ratelimit } from "../server/ratelimit";
import { authenticateBootstrap, BootstrapProofError, bootstrapRateLimit, consumeBootstrapProof } from "../services/app-bootstrap";
import { touchAppKey } from "../services/app-keys";

type BootstrapContext = { Variables: { bootstrapBody: Uint8Array<ArrayBuffer> } };

/** Count actual bytes even when Content-Length is missing or forged. Never await cancellation. */
const limitBody: MiddlewareHandler<BootstrapContext> = async (c, next) => {
  const max = Buffer.byteLength(BOOTSTRAP_BODY);
  const reject = () => c.json({ code: "body_too_large" }, 413);
  if (Number(c.req.header("Content-Length")) > max) {
    void c.req.raw.body?.cancel().catch(() => undefined);
    return reject();
  }
  const reader = c.req.raw.body?.getReader();
  const bytes = new Uint8Array(max);
  let total = 0;
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (total + chunk.value.byteLength > max) {
          void reader.cancel().catch(() => undefined);
          return reject();
        }
        bytes.set(chunk.value, total);
        total += chunk.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  }
  c.set("bootstrapBody", bytes.slice(0, total));
  await next();
};

type Dependencies = {
  db?: SQL;
  ingress?: MiddlewareHandler;
  admit?: (keyId: string) => Promise<RateLimitResult>;
};
const admit = async (kind: "ingress" | "key", identifier: string) => {
  // Use the installation's existing per-second security budget, in separate ingress and authenticated-key buckets.
  const limit = await bootstrapRateLimit();
  return ratelimit({ id: `app-bootstrap-${kind}`, limit }).check(identifier);
};

const ingress: MiddlewareHandler<BootstrapContext> = async (c, next) => {
  // Bootstrap uses the direct Core socket. Unknown peers share one bounded bucket.
  let peer = "unknown";
  try {
    peer = getConnInfo(c).remote.address ?? peer;
  } catch {
    /* In-process requests have no socket. */
  }
  const rate = await admit("ingress", clientIpBucket(peer));
  if (rate.limited) {
    c.header("Retry-After", String(Math.max(1, Math.ceil(rate.resetIn / 1000))));
    return c.json({ code: "bootstrap_ingress_limited" }, 429);
  }
  await next();
};

/** Core-only mount. Capture the startup snapshot once, including NATS file contents. */
export const createAppBootstrapRoutes = (dependencies: Dependencies = {}) => {
  const { database, valkey, nats, appSecret } = connections();
  const snapshot = BootstrapConnectionsSchema.parse({ database, valkey, nats, appSecret });
  // Refuse an undeliverable Core configuration at startup, using the largest valid identity.
  const largestIdentity = {
    installationId: "11111111-1111-4111-8111-111111111111",
    appId: "a".repeat(80),
    keyId: "22222222-2222-4222-8222-222222222222",
  };
  if (Buffer.byteLength(JSON.stringify({ identity: largestIdentity, connections: snapshot })) > BOOTSTRAP_RESPONSE_BYTES)
    throw new Error("Bootstrap response exceeds protocol budget");
  // The startup snapshot includes appId/sources; only the delivery contract goes on the wire.
  return new Hono<BootstrapContext>()
    .onError(() =>
      Response.json({ code: "bootstrap_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "1" } }),
    )
    .post(
      BOOTSTRAP_PATH,
      async (c, next) => {
        c.header("Cache-Control", "no-store");
        await next();
      },
      // The v1 request is exactly two UTF-8 bytes. This runs before proof parsing, even for invalid proofs.
      limitBody,
      dependencies.ingress ?? ingress,
      async (c) => {
        const url = new URL(c.req.url);
        if (url.search) return c.json({ code: "invalid_request" }, 400);
        const body = c.get("bootstrapBody");
        const header = c.req.header("Authorization") ?? "";
        if (!header.startsWith("Bearer ")) return c.json({ code: "invalid_proof" }, 401);
        let verified: Awaited<ReturnType<typeof authenticateBootstrap>>;
        try {
          verified = await authenticateBootstrap(header.slice(7), { method: c.req.method, path: url.pathname, body }, dependencies.db);
        } catch (error) {
          if (error instanceof BootstrapProofError) return c.json({ code: error.code }, error.code === "invalid_proof" ? 401 : 403);
          throw error;
        }
        if (new TextDecoder().decode(body) !== BOOTSTRAP_BODY) return c.json({ code: "invalid_request" }, 400);
        const { identity, jti, exp } = verified;
        const rate = dependencies.admit ? await dependencies.admit(identity.keyId) : await admit("key", identity.keyId);
        if (rate.limited) {
          c.header("Retry-After", String(Math.max(1, Math.ceil(rate.resetIn / 1000))));
          return c.json({ code: "bootstrap_rate_limited" }, 429);
        }
        if (!(await consumeBootstrapProof(identity.keyId, jti, exp, dependencies.db))) return c.json({ code: "replayed_proof" }, 403);
        await touchAppKey(identity, dependencies.db);
        const response = JSON.stringify(BootstrapResponseSchema.parse({ identity, connections: snapshot }));
        if (Buffer.byteLength(response) > BOOTSTRAP_RESPONSE_BYTES) throw new Error("Bootstrap response exceeds protocol budget");
        c.header("Content-Type", "application/json");
        return c.body(response);
      },
    );
};
