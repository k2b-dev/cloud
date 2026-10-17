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
/**
 * Bounds of Action approvals on a device. Kept apart from `APP_APPROVAL_LIMITS`, whose every value a version 1
 * authenticator checks when it connects. The texts are cut so that a whole inbox or Action stays within `bodyBytes`.
 */
export const APP_ACTION_LIMITS = {
  inboxActions: 5,
  nameChars: 60,
  titleChars: 80,
  summaryChars: 120,
  sentenceChars: 280,
  messageChars: 500,
  details: 8,
  labelChars: 40,
  valueChars: 300,
} as const;
/** Commands a Cloud serves beyond the first version, announced in `/info` as `features`. */
export const APP_APPROVAL_FEATURES = ["actions", "terminal-logins"] as const;

export const APP_APPROVAL_ACCEPT = ["terminal-logins"] as const;
export type AppApprovalAccept = (typeof APP_APPROVAL_ACCEPT)[number];

const Id = z.string().uuid();
const Secret = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
const Signature = z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/);
/** Unpadded base64url of a SHA-256 hash. */
const Digest = Secret;
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
  /** Reads the signing device's own account and device record, e.g. to show which account it signs in. */
  z.object({ operation: z.literal("account") }).strict(),
  /** Stores the authenticator's opaque push token for sign-in wake-ups on this device. */
  z.object({ operation: z.literal("push"), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
  /** Pending sign-ins and the newest open Action approvals of the signing device's account in one call. */
  z
    .object({
      operation: z.literal("inbox"),
      accept: z
        .array(z.enum(APP_APPROVAL_ACCEPT))
        .min(1)
        .max(8)
        .refine((values) => new Set(values).size === values.length)
        .optional(),
    })
    .strict(),
  /** One open Action approval as the device shows it, with the digest the device recomputes before it decides. */
  z.object({ operation: z.literal("action"), actionId: Id }).strict(),
  /** Decides an Action approval. `digest` binds the decision to exactly the view the person saw. */
  z.object({ operation: z.literal("act"), actionId: Id, digest: Digest, decision: z.enum(["approve", "deny"]) }).strict(),
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
    ...(c.operation === "push" ? [c.token] : []),
    ...(c.operation === "inbox" && c.accept !== undefined ? [c.accept] : []),
    ...(c.operation === "action" ? [c.actionId] : []),
    ...(c.operation === "act" ? [c.actionId, c.digest, c.decision] : []),
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
/** Plain text on one line: no control, format or bidirectional characters, so an app cannot fake Cloud's own frame. */
const PlainText = (max: number) =>
  z
    .string()
    .refine((value) => Array.from(value).length <= max, `Must contain at most ${max} code points`)
    .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u);
export const AppTerminalLoginSchema = z
  .object({
    client: z
      .object({
        // Bound encoded bytes including escapes, so five complete consent rows fit the response budget.
        id: PlainText(256)
          .min(1)
          .refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= 258),
        name: PlainText(APP_ACTION_LIMITS.nameChars).min(1),
      })
      .strict(),
    scopes: z
      .array(z.string().regex(/^[a-z][a-z0-9_:.-]{0,39}$/))
      .min(1)
      .max(16),
    lifetimeSeconds: z.number().int().positive(),
  })
  .strict();
export type AppTerminalLogin = z.infer<typeof AppTerminalLoginSchema>;
export const AppPendingLoginSchema = z
  .object({
    requestId: Id,
    challenge: Secret,
    comparison: Comparison,
    createdAt: DateTime,
    expiresAt: DateTime,
    terminal: AppTerminalLoginSchema.optional(),
  })
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
/** Answer to the `account` command: only the signing device's own account, never secrets or other users. */
export const AppDeviceAccountSchema = z
  .object({
    account: z.object({ uid: z.string(), displayName: z.string(), mail: z.string().nullable() }).strict(),
    device: z.object({ name: z.string(), createdAt: DateTime }).strict(),
  })
  .strict();
export type AppDeviceAccount = z.infer<typeof AppDeviceAccountSchema>;
const ActionApp = z
  .object({ id: PlainText(APP_ACTION_LIMITS.nameChars).min(1), name: PlainText(APP_ACTION_LIMITS.nameChars).min(1) })
  .strict();
const actionFields = {
  actionId: Id,
  /** The app that owns the effect, named from the Cloud's registry, never from the request. */
  app: ActionApp,
  /** The app that asked, such as the Assistant, and the title of its chat. The title is chat content, not Cloud's words. */
  requester: z.object({ app: ActionApp, title: PlainText(APP_ACTION_LIMITS.titleChars).nullable() }).strict(),
  /** `confirm` asks every time; `standard` could also be remembered in Cloud. A device decides both alike. */
  assurance: z.enum(["standard", "confirm"]),
  createdAt: DateTime,
  expiresAt: DateTime,
};
/** One inbox row. `sentence` is the start of the app's sentence; read the Action for everything the person approves. */
export const AppActionSummarySchema = z.object({ ...actionFields, sentence: PlainText(APP_ACTION_LIMITS.summaryChars).min(1) }).strict();
export const AppActionViewSchema = z
  .object({
    ...actionFields,
    /** What the Action does, in the app's words and the person's language. */
    sentence: PlainText(APP_ACTION_LIMITS.sentenceChars).min(1),
    /** The app's review of this call, or `null`. */
    message: PlainText(APP_ACTION_LIMITS.messageChars).nullable(),
    details: z
      .array(
        z
          .object({
            label: PlainText(APP_ACTION_LIMITS.labelChars).min(1),
            value: PlainText(APP_ACTION_LIMITS.valueChars),
            /** A date (`YYYY-MM-DD` or RFC 3339) or an RFC 3339 date-time the device shows in its own locale and time zone. */
            format: z.enum(["date", "date-time"]).optional(),
          })
          .strict(),
      )
      .max(APP_ACTION_LIMITS.details),
    /** Cloud shortened or left out text; the complete request is in Cloud. */
    truncated: z.boolean(),
    /** SHA-256 of the Action's real input. The device cannot check it; it binds the decision to that input. */
    argsDigest: z.string().min(1).max(128),
    digest: Digest,
  })
  .strict();
export type AppActionSummary = z.infer<typeof AppActionSummarySchema>;
export type AppActionView = z.infer<typeof AppActionViewSchema>;
export const AppDeviceInboxSchema = z
  .object({
    logins: z.array(AppPendingLoginSchema).max(APP_APPROVAL_LIMITS.pendingPerAccount),
    /** Newest first. */
    actions: z.array(AppActionSummarySchema).max(APP_ACTION_LIMITS.inboxActions),
    /** Open Action approvals beyond `actions`. */
    moreActions: z.number().int().nonnegative(),
    pollAfterSeconds: z.number().positive(),
  })
  .strict();
export type AppDeviceInbox = z.infer<typeof AppDeviceInboxSchema>;

/** UTF-8 of this exact JSON array is hashed into an Action's `digest`. Every field the device shows is part of it. */
export const appActionDigestMessage = (issuer: string, view: Omit<AppActionView, "digest">): string =>
  JSON.stringify([
    "cloud-action-v1",
    issuer,
    view.actionId,
    view.app.id,
    view.app.name,
    view.requester.app.id,
    view.requester.app.name,
    view.requester.title,
    view.assurance,
    view.sentence,
    view.message,
    view.details.map((detail) => [detail.label, detail.value, detail.format ?? null]),
    view.truncated,
    view.createdAt,
    view.expiresAt,
    view.argsDigest,
  ]);
/** Unpadded base64url of SHA-256 over `appActionDigestMessage`. Cloud and the device compute it alike. */
export const appActionDigest = async (issuer: string, view: Omit<AppActionView, "digest">): Promise<string> => {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(appActionDigestMessage(issuer, view))));
  return btoa(String.fromCharCode(...hash))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

export const AppDeviceResponseSchema = z.union([
  z
    .object({
      requests: z.array(AppPendingLoginSchema).max(APP_APPROVAL_LIMITS.pendingPerAccount),
      pollAfterSeconds: z.number().positive(),
    })
    .strict(),
  z.object({ state: z.enum(["approved", "denied", "revoked", "updated"]) }).strict(),
  AppDeviceAccountSchema,
  AppDeviceInboxSchema,
  AppActionViewSchema,
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
