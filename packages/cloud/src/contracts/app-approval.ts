import { z } from "zod";

/** Version 1 has a single algorithm and fixed signing encodings. No negotiation. */
export const APP_APPROVAL_PROTOCOL = "cloud-app-approval-v1";
export const APP_APPROVAL_PATH = "/api/auth/app-approval/v1";
export const APP_APPROVAL_LIMITS = {
  bodyBytes: 8192,
  pairingSeconds: 300,
  loginSeconds: 300,
  proofSeconds: 60,
  recentSessionSeconds: 600,
  devicesPerAccount: 20,
  pendingPerAccount: 5,
  pageSize: 20,
  pollSeconds: 5,
} as const;

const Id = z.string().uuid();
const Secret = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
const Signature = z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/);
export const AppDevicePublicKeySchema = z
  .object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: Secret,
    y: Secret,
  })
  .strict();
export type AppDevicePublicKey = z.infer<typeof AppDevicePublicKeySchema>;
export const AppPairingStartSchema = z.object({ userId: Id.optional() }).strict();
export const AppPairingClaimSchema = z
  .object({
    pairingId: Id,
    secret: Secret,
    publicKey: AppDevicePublicKeySchema,
    name: z.string().trim().min(1).max(80),
    signature: Signature,
  })
  .strict();
export const AppPairingReferenceSchema = z.object({ pairingId: Id, secret: Secret, publicKey: AppDevicePublicKeySchema }).strict();
export const AppPairingConfirmSchema = z.object({ pairingId: Id, comparison: z.string().regex(/^\d{6}$/) }).strict();
export const AppLoginStartSchema = z
  .object({
    identifier: z.string().trim().min(1).max(254),
    category: z.enum(["guest", "login", "freeipa"]),
  })
  .strict();
export const AppLoginReferenceSchema = z.object({ requestId: Id, browserSecret: Secret }).strict();
export const AppDeviceMutationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("rename"), deviceId: Id, name: z.string().trim().min(1).max(80) }).strict(),
  z.object({ operation: z.literal("revoke"), deviceId: Id }).strict(),
]);
export const AppDeviceCommandSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("pending") }).strict(),
  z.object({ operation: z.literal("revoke") }).strict(),
  z
    .object({
      operation: z.literal("decide"),
      requestId: Id,
      challenge: Secret,
      comparison: z.string().regex(/^\d{6}$/),
      decision: z.enum(["approve", "deny"]),
    })
    .strict(),
]);
export const AppDeviceProofSchema = z
  .object({
    issuer: z.string().url(),
    deviceId: Id,
    jti: Id,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    command: AppDeviceCommandSchema,
  })
  .strict();
export const AppDeviceRequestSchema = z.object({ proof: AppDeviceProofSchema, signature: Signature }).strict();
export type AppDeviceProof = z.infer<typeof AppDeviceProofSchema>;
export type AppDeviceRequest = z.infer<typeof AppDeviceRequestSchema>;

/** UTF-8 of this exact JSON array; signatures use WebCrypto ECDSA P-256/SHA-256,
 * 64-byte IEEE-P1363 r||s, encoded as unpadded base64url. */
export const appDeviceProofMessage = (proof: AppDeviceProof): string => {
  const c = proof.command;
  return JSON.stringify([
    APP_APPROVAL_PROTOCOL,
    "device",
    proof.issuer,
    proof.deviceId,
    proof.jti,
    proof.issuedAt,
    proof.expiresAt,
    c.operation,
    ...(c.operation === "decide" ? [c.requestId, c.challenge, c.comparison, c.decision] : []),
  ]);
};
export const appPairingProofMessage = (issuer: string, claim: Omit<z.infer<typeof AppPairingClaimSchema>, "signature">): string =>
  JSON.stringify([
    APP_APPROVAL_PROTOCOL,
    "pair",
    issuer,
    claim.pairingId,
    claim.secret,
    claim.publicKey.kty,
    claim.publicKey.crv,
    claim.publicKey.x,
    claim.publicKey.y,
    claim.name,
  ]);

const DateTime = z.string().datetime();
const Comparison = z.string().regex(/^\d{6}$/);
export const AppDeviceViewSchema = z
  .object({
    id: Id,
    name: z.string(),
    createdAt: DateTime,
    lastUsedAt: DateTime.nullable(),
    revokedAt: DateTime.nullable(),
    assisted: z.boolean(),
  })
  .strict();
export const AppPendingLoginSchema = z
  .object({ requestId: Id, challenge: Secret, comparison: Comparison, createdAt: DateTime, expiresAt: DateTime })
  .strict();
export const AppPairingPayloadSchema = z
  .object({ protocol: z.literal(APP_APPROVAL_PROTOCOL), issuer: z.string().url(), pairingId: Id, secret: Secret, expiresAt: DateTime })
  .strict();
export type AppPairingPayload = z.infer<typeof AppPairingPayloadSchema>;

const pairingOrigin = (value: string): string => {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid pairing origin");
  return url.origin;
};

/** The same fragment-only link is used for QR, copy/paste and same-device opening. */
export const appPairingLink = (authenticatorOrigin: string, payload: AppPairingPayload): string => {
  const parsed = AppPairingPayloadSchema.parse(payload);
  if (pairingOrigin(parsed.issuer) !== parsed.issuer) throw new Error("Invalid pairing issuer");
  const link = `${pairingOrigin(authenticatorOrigin)}/#pairing=${encodeURIComponent(JSON.stringify(parsed))}`;
  if (link.length > APP_APPROVAL_LIMITS.bodyBytes) throw new Error("Pairing link too long");
  return link;
};

/** Parses untrusted pasted/scanned text without fetching or trusting the issuer.
 * The caller must obtain consent, validate discovery and clear the fragment. */
export const parseAppPairingLink = (input: string, authenticatorOrigin: string): AppPairingPayload => {
  if (input.length > APP_APPROVAL_LIMITS.bodyBytes) throw new Error("Pairing link too long");
  const url = new URL(input.trim());
  if (
    url.origin !== pairingOrigin(authenticatorOrigin) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    !url.hash.startsWith("#pairing=")
  )
    throw new Error("Invalid pairing link");
  const payload = AppPairingPayloadSchema.parse(JSON.parse(decodeURIComponent(url.hash.slice("#pairing=".length))));
  if (pairingOrigin(payload.issuer) !== payload.issuer) throw new Error("Invalid pairing issuer");
  return payload;
};
export const AppPairingClaimResultSchema = z.object({ deviceId: Id, comparison: Comparison, expiresAt: DateTime }).strict();
export const AppPairingResultSchema = z
  .object({ state: z.enum(["pending", "claimed", "confirmed", "cancelled"]), deviceId: Id.nullable(), comparison: Comparison.nullable() })
  .strict();
/** Initiating Cloud session only; never returned to an unpaired device. */
export const AppPairingInspectionSchema = AppPairingResultSchema.extend({ name: z.string().nullable(), userId: Id });
export const AppDeviceResponseSchema = z.union([
  z
    .object({
      requests: z.array(AppPendingLoginSchema).max(APP_APPROVAL_LIMITS.pendingPerAccount),
      pollAfterSeconds: z.number().positive(),
    })
    .strict(),
  z.object({ state: z.enum(["approved", "denied", "revoked"]) }).strict(),
]);
export const AppLoginStartResultSchema = z
  .object({ requestId: Id, browserSecret: Secret, comparison: Comparison, expiresAt: DateTime, pollAfterSeconds: z.number().positive() })
  .strict();
export const AppLoginStatusSchema = z
  .object({ state: z.enum(["pending", "approved", "denied", "consumed", "expired"]), pollAfterSeconds: z.number().positive() })
  .strict();
export const AppDevicesPageSchema = z
  .object({ items: z.array(AppDeviceViewSchema).max(APP_APPROVAL_LIMITS.pageSize), nextCursor: Id.nullable() })
  .strict();
export type AppDeviceView = z.infer<typeof AppDeviceViewSchema>;
export type AppPendingLogin = z.infer<typeof AppPendingLoginSchema>;
