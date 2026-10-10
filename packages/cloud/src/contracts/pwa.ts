import { z } from "zod";
import { isPwaPartId, PWA_AUTH_PATH, PWA_RESERVED_IDS, PWA_SCOPE, PWA_SERVICE_WORKER_PATH } from "./pwa-paths";

export { isPwaPartId, PWA_AUTH_PATH, PWA_RESERVED_IDS, PWA_SCOPE, PWA_SERVICE_WORKER_PATH };

/**
 * The installable mobile app (preview). One shell application `pwa` owns the
 * manifest scope `/pwa/`; Core owns the phone-side identity endpoints below
 * `/pwa/_auth` and the web-side pairing API.
 */
export const PWA_SHELL_APP_ID = "pwa";
export const PWA_API_PATH = "/api/auth/pwa/v1";
export const PWA_MANIFEST_PATH = "/pwa/manifest.webmanifest";
/**
 * The page canvas of the app (`--k2b-surface-canvas` of `@k2b/ui`) in light and dark. App documents paint it
 * before any stylesheet loads and give it to the status bar.
 */
export const PWA_CANVAS_COLORS = { light: "#fafafa", dark: "#090d12" } as const;

/** Cookie names. Only `pwa_session` reaches every application; the others use Core-only paths. */
export const PWA_COOKIES = {
  session: "pwa_session",
  device: "pwa_device",
  pairing: "pwa_pairing",
} as const;

export const PWA_LIMITS = {
  /** Same as the Cloud Login API. */
  bodyBytes: 8192,
  /** A visible link can be claimed for five minutes. */
  linkClaimSeconds: 300,
  /** Claim, typing the code and completion. */
  pairingSeconds: 600,
  /** Starting a pairing needs a web sign-in from the last ten minutes. */
  recentSessionSeconds: 600,
  /** Wrong codes before the pairing is cancelled. */
  confirmAttempts: 3,
  devicesPerAccount: 20,
  pendingPerAccount: 5,
  /** A paired phone ends after this many days without use. */
  idleDays: 150,
  /** Lifetime of one app session. */
  sessionSeconds: 86_400,
  /** Renew when the app session has less than this left. */
  renewWithinSeconds: 43_200,
  /** Parallel renewals within this window do not re-issue. */
  rotationGraceSeconds: 60,
  pollSeconds: 5,
  nameMaxLength: 80,
} as const;

/** True while a live app with id "pwa" owns "/pwa". Pure; Core uses it for gating. */
export const isPwaShellAvailable = (apps: readonly { id: string; routes: readonly string[] }[]): boolean =>
  apps.some((app) => app.id === PWA_SHELL_APP_ID && app.routes.includes("/pwa"));

const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The link the web shows as QR code and copy text. The secret lives only in the fragment. */
export const pairingLink = (origin: string, secret: string): string => {
  if (!SECRET_PATTERN.test(secret)) throw new Error("Invalid pairing secret");
  return `${new URL(origin).origin}${PWA_SCOPE}#pair=${secret}`;
};

export type PairingLinkResult = { ok: true; secret: string } | { ok: false; reason: "invalid" | "other-cloud" | "cloud-login" };

/** Strict parser for scanned or pasted text. Never fetches anything. */
export const parsePairingLink = (text: string, origin: string): PairingLinkResult => {
  if (text.length > PWA_LIMITS.bodyBytes) return { ok: false, reason: "invalid" };
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.hash.startsWith("#pairing=")) return { ok: false, reason: "cloud-login" };
  if (!url.hash.startsWith("#pair=") || url.pathname !== PWA_SCOPE || url.search || url.username || url.password) {
    return { ok: false, reason: "invalid" };
  }
  if (url.origin !== new URL(origin).origin) return { ok: false, reason: "other-cloud" };
  const secret = url.hash.slice("#pair=".length);
  return SECRET_PATTERN.test(secret) ? { ok: true, secret } : { ok: false, reason: "invalid" };
};

const Id = z.string().uuid();
const DateTime = z.string().datetime();
const Code = z.string().regex(/^\d{6}$/);

export const PwaPlatformSchema = z.enum(["ios", "android", "other"]);
export type PwaPlatform = z.infer<typeof PwaPlatformSchema>;
export const PwaPairingStateSchema = z.enum(["pending", "claimed", "confirmed", "completed", "cancelled"]);
export type PwaPairingState = z.infer<typeof PwaPairingStateSchema>;
/** States of `/pwa/` the launch bounce leads to when it cannot renew. */
export const PwaLaunchStateSchema = z.enum(["new", "ended", "blocked", "unavailable"]);
export type PwaLaunchState = z.infer<typeof PwaLaunchStateSchema>;

export const PwaErrorCodeSchema = z.enum([
  "UNAVAILABLE",
  "REAUTHENTICATE",
  "FORBIDDEN",
  "ACCOUNT_BLOCKED",
  "INVALID_REQUEST",
  "NOT_FOUND",
  "EXPIRED",
  "ALREADY_USED",
  "WRONG_CODE",
  "CONFLICT",
  "ALREADY_PAIRED",
  "ACCOUNT_MISMATCH",
  "LIMIT_REACHED",
  "UNPAIRED",
]);
export type PwaErrorCode = z.infer<typeof PwaErrorCodeSchema>;
export const PwaErrorSchema = z.object({ code: PwaErrorCodeSchema, message: z.string(), attemptsLeft: z.number().int().optional() });

// Web side (`/api/auth/pwa/v1`).
export const PwaPairingStartResultSchema = z
  .object({ id: Id, secret: z.string().regex(SECRET_PATTERN), claimUntil: DateTime, expiresAt: DateTime })
  .strict();
export const PwaPairingStatusSchema = z
  .object({
    state: PwaPairingStateSchema,
    claimUntil: DateTime,
    expiresAt: DateTime,
    device: z.object({ name: z.string(), platform: PwaPlatformSchema }).strict().nullable(),
    attemptsLeft: z.number().int().min(0),
  })
  .strict();
export const PwaPairingConfirmSchema = z.object({ code: Code }).strict();
export const PwaDeviceViewSchema = z
  .object({
    id: Id,
    name: z.string(),
    platform: PwaPlatformSchema,
    createdAt: DateTime,
    lastUsedAt: DateTime,
    current: z.boolean(),
  })
  .strict();
export type PwaDeviceView = z.infer<typeof PwaDeviceViewSchema>;
export const PwaDeviceListSchema = z.object({ items: z.array(PwaDeviceViewSchema) }).strict();

// Phone side (`/pwa/_auth`).
export const PwaClaimSchema = z.object({ secret: z.string().regex(SECRET_PATTERN), platform: PwaPlatformSchema }).strict();
const Account = z.object({ name: z.string() }).strict();
export const PwaClaimResultSchema = z.object({ code: Code, account: Account, expiresAt: DateTime }).strict();
export const PwaCompleteResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("paired") }).strict(),
  z.object({ state: z.literal("waiting"), code: Code, account: Account, expiresAt: DateTime }).strict(),
]);
export const PwaRenewResultSchema = z.object({ renewed: z.boolean(), otherAccount: Account.optional() }).strict();
export const PwaRenameSchema = z.object({ name: z.string().trim().min(1).max(PWA_LIMITS.nameMaxLength) }).strict();
