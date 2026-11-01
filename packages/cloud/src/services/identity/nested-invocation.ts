import { z } from "zod";
import type { RequestCredentialProof } from "../../server/middleware/auth";
import { resolveOAuthTokenActor } from "../oauth-tokens";
import { requestCacheRedis } from "../request-cache-redis";
import { getOverview } from "../service-account-credentials";
import { loadJwtSessionIdentity } from "../session/user";
import { CLOUD_INVOCATION_TOKEN_TTL_SECONDS, IDENTITY_MAX_COMPACT_TOKEN_BYTES } from "./constants";
import type { CloudInvocationClaims } from "./invocation-token";
import { getIdentityRuntimeConfig } from "./runtime-config";

// The first consumer performs one resource-reader check. Budget exactly that
// dependency: one Query, one hop, no recursive fan-out or automatic retries.
// Optional lease setup may spend at most 1% of the parent's 30-second token
// lifetime (300 ms), taken from the original operation's remaining budget.
export const NESTED_INVOCATION_SETUP_BUDGET_MS = (CLOUD_INVOCATION_TOKEN_TTL_SECONDS * 1000) / 100;

const ProofSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("session"),
      userId: z.uuid(),
      sid: z.uuid(),
      authEpoch: z.number().int().nonnegative(),
      expiresAt: z.iso.datetime(),
    })
    .strict(),
  z.object({ kind: z.literal("oauth"), payload: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ kind: z.literal("api_key"), credentialId: z.uuid() }).strict(),
]);
const LeaseSchema = z
  .object({
    appId: z.string(),
    deadline: z.number().int().positive(),
    origin: z.enum(["http", "app", "assistant", "mcp"]),
    proof: ProofSchema.optional(),
    assistantTurn: z.object({ conversationId: z.uuid(), turnId: z.uuid() }).strict().optional(),
  })
  .strict()
  .refine((lease) => (lease.origin === "assistant") === !!lease.assistantTurn, { message: "Turn authority requires the Assistant origin" });
export type NestedInvocationLease = z.infer<typeof LeaseSchema>;

const key = (id: string) => `identity:nested:v1:${id}`;
const TAKE = `local value = redis.call('GET', KEYS[1])
if not value or redis.call('EXISTS', KEYS[2]) == 1 then return nil end
redis.call('SET', KEYS[2], '1', 'PX', ARGV[1])
return value`;

export const nestedInvocationLeases = {
  async create(claims: CloudInvocationClaims, lease: NestedInvocationLease, signal?: AbortSignal): Promise<void> {
    const value = LeaseSchema.parse(lease);
    const ttl = Math.min(claims.exp * 1000, value.deadline) - Date.now();
    if (ttl <= 0) throw new Error("Invocation expired");
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > IDENTITY_MAX_COMPACT_TOKEN_BYTES)
      throw new Error("Invocation lease exceeds the identity metadata budget");
    const client = await requestCacheRedis();
    signal?.throwIfAborted();
    await client.send("SET", [key(claims.jti), json, "PX", String(ttl), "NX"]);
    // A command already sent cannot be cancelled. Remove its late result when
    // the bounded setup has released the original dispatch in the meantime.
    if (signal?.aborted) {
      await client.send("DEL", [key(claims.jti)]);
      signal.throwIfAborted();
    }
  },
  async read(id: string): Promise<NestedInvocationLease | null> {
    const value = await (await requestCacheRedis()).send("GET", [key(id)]);
    if (typeof value !== "string" || Buffer.byteLength(value) > IDENTITY_MAX_COMPACT_TOKEN_BYTES) return null;
    const parsed = LeaseSchema.safeParse(JSON.parse(value));
    return parsed.success && parsed.data.deadline > Date.now() ? parsed.data : null;
  },
  async take(id: string): Promise<NestedInvocationLease | null> {
    const value = await (await requestCacheRedis()).send("EVAL", [
      TAKE,
      "2",
      key(id),
      `${key(id)}:used`,
      String(CLOUD_INVOCATION_TOKEN_TTL_SECONDS * 1000),
    ]);
    if (typeof value !== "string" || Buffer.byteLength(value) > IDENTITY_MAX_COMPACT_TOKEN_BYTES) return null;
    const parsed = LeaseSchema.safeParse(JSON.parse(value));
    return parsed.success && parsed.data.deadline > Date.now() ? parsed.data : null;
  },
  async revoke(id: string): Promise<void> {
    await (await requestCacheRedis()).send("DEL", [key(id)]);
  },
};

/** Recheck the source's revocation coordinates; no reusable credential is stored. */
export const isNestedSourceCurrent = async (
  proof: RequestCredentialProof,
  parent: Pick<CloudInvocationClaims, "sub" | "credential_kind" | "credential_id" | "principal_type" | "scopes">,
): Promise<boolean> => {
  if (proof.kind !== parent.credential_kind) return false;
  if (proof.kind === "session") {
    return (
      proof.userId === parent.sub &&
      Date.parse(proof.expiresAt) > Date.now() &&
      !!(await loadJwtSessionIdentity({ userId: proof.userId, sid: proof.sid, authEpoch: proof.authEpoch }))
    );
  }
  if (proof.kind === "api_key") {
    if (proof.credentialId !== parent.credential_id) return false;
    const credential = await getOverview({ id: proof.credentialId });
    return (
      !!credential &&
      credential.status === "active" &&
      credential.serviceAccountId === parent.sub &&
      (!credential.expiresAt || Date.parse(credential.expiresAt) > Date.now()) &&
      parent.scopes.length === credential.scopes.length &&
      parent.scopes.every((scope) => credential.scopes.includes(scope))
    );
  }
  if (typeof proof.payload.exp !== "number" || proof.payload.exp * 1000 <= Date.now()) return false;
  const current = await resolveOAuthTokenActor(proof.payload, (await getIdentityRuntimeConfig()).groupsAdmin);
  return (
    !!current &&
    current.kind === parent.principal_type &&
    (current.kind === "user" ? current.user.id : current.serviceAccount.id) === parent.sub &&
    parent.scopes.every((scope) => current.scopes.includes(scope))
  );
};

export const nestedSourceDeadline = (proof: RequestCredentialProof | undefined): number => {
  if (proof?.kind === "session") return Date.parse(proof.expiresAt);
  if (proof?.kind === "oauth") return typeof proof.payload.exp === "number" ? proof.payload.exp * 1000 : 0;
  return Infinity;
};
