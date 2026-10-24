import { X509Certificate } from "node:crypto";
import type { sql } from "bun";
import { setFreeIpaTlsResolver } from "../server/services/freeipa/tls";
import { coreSettings } from "./settings/api";
import { decryptValue } from "./settings/crypto";

const MAX_CA_CERT_BYTES = 256 * 1024;
const PEM_CERTIFICATE_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

export type FreeIpaSyncGuard = {
  maxUserChanges: number;
  maxUserChangePercent: number;
  maxGroupDeletions: number;
  maxGroupDeletionPercent: number;
};

export type FreeIpaConfig = {
  enabled: boolean;
  configured: boolean;
  /** Setting keys that are still empty. Empty when `configured` is true. */
  missingSettings: string[];
  url: string;
  serviceUser: string;
  servicePassword: string;
  groupsAdmin: string[];
  groupsBaseSync: string[];
  groupsBaseIpaRealm: string[];
  groupsExcluded: string[];
  caCert: string;
  allowInsecure: boolean;
  syncGuard: FreeIpaSyncGuard;
};

const normalizeString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const normalizeNonNegativeNumber = (value: unknown, fallback: number): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};
const normalizeNonNegativeInteger = (value: unknown, fallback: number): number => Math.floor(normalizeNonNegativeNumber(value, fallback));
const normalizePercentage = (value: unknown, fallback: number): number => Math.min(100, normalizeNonNegativeNumber(value, fallback));

export const validateFreeIpaCaCert = (value: unknown): { ok: true; value: string } | { ok: false; error: string } => {
  if (typeof value !== "string") return { ok: false, error: "CA certificate must be PEM text" };
  const normalized = value.trim();
  if (!normalized) return { ok: true, value: "" };
  if (new TextEncoder().encode(normalized).byteLength > MAX_CA_CERT_BYTES) {
    return { ok: false, error: "CA certificate bundle must not exceed 256 KiB" };
  }

  const certificates = normalized.match(PEM_CERTIFICATE_PATTERN) ?? [];
  const remainder = normalized.replace(PEM_CERTIFICATE_PATTERN, "").trim();
  if (certificates.length === 0 || remainder.length > 0) {
    return { ok: false, error: "Enter one or more complete PEM certificates" };
  }

  try {
    for (const certificate of certificates) new X509Certificate(certificate);
  } catch {
    return { ok: false, error: "CA certificate contains invalid PEM data" };
  }
  return { ok: true, value: normalized };
};

export const resolveFreeIpaTlsOptions = (caCert: string, allowInsecure: boolean): Bun.TLSOptions => {
  const certificate = validateFreeIpaCaCert(caCert);
  if (!certificate.ok) throw new Error(`Invalid freeipa.ca_cert: ${certificate.error}`);
  if (certificate.value) return { ca: certificate.value, rejectUnauthorized: true };
  if (allowInsecure) return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
};

/**
 * `fallback` is only for groups that have a genuine FreeIPA-wide default.
 *
 * The scope groups deliberately have none: `base_sync` decides who gets a Cloud
 * account at all and `base_ipa_realm` decides who is a full user rather than a
 * guest, and both depend entirely on how the directory is organised. A guess
 * either over-provisions every FreeIPA user or silently demotes everyone to
 * guest, so an empty value has to make the config incomplete instead.
 */
const normalizeStringList = (value: unknown, fallback: string[] = []): string[] => {
  if (!Array.isArray(value)) return fallback;
  const normalized = value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
  return normalized.length > 0 ? normalized : fallback;
};

/** Durable authority reads bypass the settings cache; callers own transaction locks. */
export const getFreeIpaAdminGroups = async (db: typeof sql): Promise<string[]> => {
  const [row] = await db<{ value: string }[]>`SELECT value FROM settings.entries WHERE key='freeipa.groups.admin'`;
  if (!row) return ["admins"];
  const value = await decryptValue(row.value);
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string"))
    throw new Error("Invalid FreeIPA administrator configuration");
  return normalizeStringList(value, ["admins"]);
};

/**
 * Read the full FreeIPA config snapshot from settings (Redis cache-aside +
 * Postgres fallback). Always returns within Redis-TTL fresh data — no hidden
 * dependency on request-lifecycle middleware.
 */
export const getFreeIpaConfig = async (): Promise<FreeIpaConfig> => {
  const [
    rawUrl,
    rawServiceUser,
    rawServicePassword,
    rawEnabled,
    rawAdmin,
    rawBaseSync,
    rawBaseIpaRealm,
    rawExcluded,
    rawCaCert,
    rawAllowInsecure,
    rawMaxUserChanges,
    rawMaxUserChangePercent,
    rawMaxGroupDeletions,
    rawMaxGroupDeletionPercent,
  ] = await Promise.all([
    coreSettings.get<string>("freeipa.url"),
    coreSettings.get<string>("freeipa.service_user"),
    coreSettings.get<string>("freeipa.service_password"),
    coreSettings.get<boolean>("freeipa.enable"),
    coreSettings.get<string[]>("freeipa.groups.admin"),
    coreSettings.get<string[]>("freeipa.groups.base_sync"),
    coreSettings.get<string[]>("freeipa.groups.base_ipa_realm"),
    coreSettings.get<string[]>("freeipa.groups.excluded"),
    coreSettings.get<string>("freeipa.ca_cert"),
    coreSettings.get<boolean>("freeipa.allow_insecure"),
    coreSettings.get<number>("freeipa.sync_guard.max_user_changes"),
    coreSettings.get<number>("freeipa.sync_guard.max_user_change_percent"),
    coreSettings.get<number>("freeipa.sync_guard.max_group_deletions"),
    coreSettings.get<number>("freeipa.sync_guard.max_group_deletion_percent"),
  ]);

  const url = normalizeString(rawUrl);
  const serviceUser = normalizeString(rawServiceUser);
  const servicePassword = normalizeString(rawServicePassword);
  const enabled = Boolean(rawEnabled);
  const caCert = normalizeString(rawCaCert);
  const caValidation = validateFreeIpaCaCert(caCert);

  // "admins" and the excluded list are real FreeIPA defaults; the scope groups
  // are not, so they stay empty and make the config incomplete.
  const groupsAdmin = normalizeStringList(rawAdmin, ["admins"]);
  const groupsBaseSync = normalizeStringList(rawBaseSync);
  const groupsBaseIpaRealm = normalizeStringList(rawBaseIpaRealm);
  const groupsExcluded = normalizeStringList(rawExcluded, ["editors", "trust admins", "admins"]);

  const missingSettings = [
    ...(url ? [] : ["freeipa.url"]),
    ...(serviceUser ? [] : ["freeipa.service_user"]),
    ...(servicePassword ? [] : ["freeipa.service_password"]),
    ...(groupsBaseSync.length > 0 ? [] : ["freeipa.groups.base_sync"]),
    ...(groupsBaseIpaRealm.length > 0 ? [] : ["freeipa.groups.base_ipa_realm"]),
    ...(caValidation.ok ? [] : ["freeipa.ca_cert"]),
  ];

  return {
    enabled,
    configured: missingSettings.length === 0,
    missingSettings,
    url,
    serviceUser,
    servicePassword,
    groupsAdmin,
    groupsBaseSync,
    groupsBaseIpaRealm,
    groupsExcluded,
    caCert,
    allowInsecure: Boolean(rawAllowInsecure),
    syncGuard: {
      maxUserChanges: normalizeNonNegativeInteger(rawMaxUserChanges, 10),
      maxUserChangePercent: normalizePercentage(rawMaxUserChangePercent, 20),
      maxGroupDeletions: normalizeNonNegativeInteger(rawMaxGroupDeletions, 5),
      maxGroupDeletionPercent: normalizePercentage(rawMaxGroupDeletionPercent, 20),
    },
  };
};

// ── TLS resolver wiring ──────────────────────────────────────────────────────
// Register an async resolver at module load so the freeipa transport
// (`server/services/freeipa/client.ts` + `session.ts`) can read TLS opts
// without taking a hard dependency on settings (would create a layering cycle).
//
// Resolution order: ca_cert (proper, signed by your private CA) wins over
// allow_insecure (lab/dev kill switch). Verification is explicit in every
// secure mode so NODE_TLS_REJECT_UNAUTHORIZED cannot weaken this policy.
setFreeIpaTlsResolver(async () => {
  const config = await getFreeIpaConfig();
  return resolveFreeIpaTlsOptions(config.caCert, config.allowInsecure);
});
