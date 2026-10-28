import type { SQL, TransactionSQL } from "bun";
import { z } from "zod";
import type { AppInstallable } from "../contracts/installable";
import type { PermissionLevel } from "../server/services/access";

export const APP_PWA_LIMITS = {
  qrSeconds: 120,
  deviceSeconds: 12 * 60 * 60,
  visitIdleSeconds: 15 * 60,
  visitSeconds: 60 * 60,
} as const;

export const AppPwaId = z.uuid();
export const AppPwaSecret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const AppPwaClaim = z.strictObject({ qr: z.string() });
export const AppPwaAttempt = z.strictObject({ attemptId: AppPwaId, input: z.unknown() });

export type AppPwaDeviceActor = {
  kind: "device";
  appId: string;
  deviceId: string;
  ownerUserId: string;
};
export type AppPwaVisitActor = Omit<AppPwaDeviceActor, "kind"> & {
  kind: "visit";
  visitId: string;
  /** Validated against the application's subject schema. Domain interpretation belongs to the app. */
  subject: unknown;
};
export type AppPwaActor = AppPwaDeviceActor | AppPwaVisitActor;
export type AppPwaDeviceView = {
  id: string;
  name: string;
  state: "pending" | "active" | "expired" | "revoked";
  expiresAt: string | null;
};
export type AppPwaVisitView = {
  id: string;
  state: "pending" | "active" | "expired" | "ended" | "revoked";
  expiresAt: string | null;
  idleExpiresAt: string | null;
};
export type AppPwaWebSignIn = { userId: string; sid: string };
export type AppPwaStaffAction = "issue-device" | "list-devices" | "device-status" | "revoke-device" | "issue-visit" | "revoke-visit";

export type AppPwaVisitContext = {
  actor: AppPwaVisitActor;
  tx: TransactionSQL;
  signal: AbortSignal;
};
export type AppPwaCommandContext = AppPwaVisitContext & {
  /** Complete the visit atomically with the domain write and its attempt result. */
  endVisit(): void;
};
export type AppPwaDeviceContext = {
  actor: AppPwaDeviceActor;
  tx: TransactionSQL;
  signal: AbortSignal;
};

export type AppPwaQuery = {
  run(context: AppPwaVisitContext, input: unknown): Promise<unknown>;
};
export type AppPwaCommand = {
  parse(input: unknown): unknown;
  run(context: AppPwaCommandContext, input: unknown): Promise<unknown>;
};
export type AppPwaDeviceOperation = {
  permission: Exclude<PermissionLevel, "none">;
  run(context: AppPwaDeviceContext, input: unknown): Promise<unknown>;
  /** Lock the app-owned resource/junction rows that determine these grant IDs. Called again before commit. */
  accessIds(context: AppPwaDeviceContext, input: unknown): Promise<string[]>;
};

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppPwaError("INVALID_INPUT", 400);
  return result.data;
};

/** A query never renews a visit. Use the supplied transaction even for domain reads. */
export const appPwaQuery = <I, O>(definition: {
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  handler(context: AppPwaVisitContext, input: I): Promise<O>;
}): AppPwaQuery => ({
  run: async (context, input) => parse(definition.output, await definition.handler(context, parse(definition.input, input))),
});

/** Only a newly committed successful command renews idle time. Live retries return the stored result; terminal retries return status only. */
export const appPwaCommand = <I, O>(definition: {
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  handler(context: AppPwaCommandContext, input: I): Promise<O>;
}): AppPwaCommand => ({
  parse: (input) => parse(definition.input, input),
  run: async (context, input) => parse(definition.output, await definition.handler(context, parse(definition.input, input))),
});

/**
 * A device-only local service adapter. It receives device provenance, never owner credentials.
 * The platform intersects its explicit ceiling with current resource grants before calling it.
 * Cross-app credential exchange is deliberately outside this adapter's contract.
 */
export const appPwaDeviceOperation = <I, O>(definition: {
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  permission: Exclude<PermissionLevel, "none">;
  accessIds(context: AppPwaDeviceContext, input: I): Promise<string[]>;
  handler(context: AppPwaDeviceContext, input: I): Promise<O>;
}): AppPwaDeviceOperation => ({
  permission: definition.permission,
  accessIds: (context, input) => definition.accessIds(context, parse(definition.input, input)),
  run: async (context, input) => parse(definition.output, await definition.handler(context, parse(definition.input, input))),
});

export type AppPwaOptions = {
  app: { id: string; installable: Pick<AppInstallable, "path"> };
  /** Authoritative configured public origin, never a Host/Forwarded/request header. HTTPS is mandatory. */
  publicOrigin: string;
  schema: string;
  db?: SQL;
  /** Positive safe integer seconds; capped at 12 hours, then bounded by browser and initiating family. */
  deviceTtlSeconds?: number;
  subject: z.ZodType;
  /** Explicit application budgets, covering transport, stored results, and staff pagination. */
  budgets: { requestBytes: number; responseBytes: number; listPageSize: number; maxAccessIds: number };
  /** Mandatory application authorization, repeated under the current web authority locks for every staff action. */
  authorizeStaff(action: AppPwaStaffAction, signIn: AppPwaWebSignIn, tx: TransactionSQL): Promise<boolean>;
  /** Authorize exposing this validated domain subject to a customer; lock its authority using tx.
   * Called before issuance and again before commit, including issuance retries. */
  authorizeVisit(signIn: AppPwaWebSignIn, subject: unknown, tx: TransactionSQL): Promise<boolean>;
  queries?: Readonly<Record<string, AppPwaQuery>>;
  commands?: Readonly<Record<string, AppPwaCommand>>;
  deviceOperations?: Readonly<Record<string, AppPwaDeviceOperation>>;
  /** Missing operation declarations deny access; operation registration alone grants nothing. */
  devicePermissions?: Readonly<Record<string, Exclude<PermissionLevel, "none">>>;
};

export type AppPwaErrorCode =
  | "INVALID_INPUT"
  | "INVALID_QR"
  | "ORIGIN_REQUIRED"
  | "JSON_REQUIRED"
  | "CSRF_REQUIRED"
  | "BROWSER_REQUIRED"
  | "DUPLICATE_COOKIE"
  | "WEB_SESSION_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "EXPIRED"
  | "REVOKED"
  | "ALREADY_CLAIMED"
  | "ACTIVE_VISIT"
  | "ATTEMPT_CONFLICT"
  | "TOO_LARGE"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | `APP_${string}`;

export class AppPwaError extends Error {
  constructor(
    readonly code: AppPwaErrorCode,
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 429 | 503,
  ) {
    super(code);
  }
}

export const pwaFail = (code: AppPwaErrorCode, status: AppPwaError["status"]): never => {
  throw new AppPwaError(code, status);
};
export const parseAppPwaInput = parse;
