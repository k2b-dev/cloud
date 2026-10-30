/** Bootstrap v1 has no platform barrel or application dependencies. */
import { SignJWT } from "jose";
import { z } from "zod";
import { type AppKey, importAppKeySeed } from "../app-key";
import type { PlatformConnectionValues } from "./connections";

export const BOOTSTRAP_PATH = "/_internal/apps/bootstrap";
export const BOOTSTRAP_TYPE = "cloud-app+jwt";
export const BOOTSTRAP_BODY = "{}";
export const BOOTSTRAP_RESPONSE_BYTES = 64 * 1024;
// Same compact-token budget as Cloud's identity protocols.
export const BOOTSTRAP_PROOF_BYTES = 4 * 1024;
export const BOOTSTRAP_BUDGET_MS = 5 * 60_000;
export const BOOTSTRAP_ATTEMPT_MS = 10_000;
export const BOOTSTRAP_PROOF_SECONDS = 30;
export const BOOTSTRAP_REPLAY_RETENTION_SECONDS = 5 * 60;

const nonempty = z.string().refine((value) => value.trim().length > 0);
export const BootstrapIdentitySchema = z.object({ installationId: z.uuid(), appId: z.string(), keyId: z.uuid() }).strict();
export type BootstrapIdentity = z.infer<typeof BootstrapIdentitySchema>;
export const BootstrapConnectionsSchema = z
  .object({
    database: z.object({ url: nonempty }).strict(),
    valkey: z.object({ url: nonempty }).strict(),
    nats: z
      .object({
        servers: z.array(nonempty).nonempty(),
        namespace: nonempty,
        replicas: z.union([z.literal(1), z.literal(3), z.literal(5)]),
        ignoreClusterUpdates: z.boolean(),
        creds: nonempty.optional(),
        ca: nonempty.optional(),
      })
      .strict(),
    appSecret: z.object({ current: nonempty, previous: nonempty.optional(), next: nonempty.optional() }).strict(),
  })
  .strict() satisfies z.ZodType<PlatformConnectionValues>;
export const BootstrapResponseSchema = z.object({ identity: BootstrapIdentitySchema, connections: BootstrapConnectionsSchema }).strict();
export type BootstrapResponse = z.infer<typeof BootstrapResponseSchema>;

export const bootstrapBodyDigest = async (body: Uint8Array<ArrayBuffer>): Promise<string> =>
  Buffer.from(await crypto.subtle.digest("SHA-256", body)).toString("base64url");

/** Call at the HTTP transmission seam, including every retry. */
export const signBootstrapProof = async (key: AppKey, now = Date.now()): Promise<string> => {
  const iat = Math.floor(now / 1000);
  return new SignJWT({
    htm: "POST",
    htu: BOOTSTRAP_PATH,
    bdh: await bootstrapBodyDigest(new TextEncoder().encode(BOOTSTRAP_BODY)),
  })
    .setProtectedHeader({ alg: "EdDSA", typ: BOOTSTRAP_TYPE, kid: key.keyId })
    .setIssuer(key.appId)
    .setSubject(key.appId)
    .setAudience(`cloud-core:${key.installationId}`)
    .setIssuedAt(iat)
    .setExpirationTime(iat + BOOTSTRAP_PROOF_SECONDS)
    .setJti(crypto.randomUUID())
    .sign(await importAppKeySeed(key.seed));
};
