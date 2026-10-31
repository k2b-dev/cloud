import type { SQL } from "bun";
import { PWA_COOKIES } from "./pwa";

/**
 * App public surface and app domains: the contract Core, the platform, and the gateway share.
 *
 * An app with `defineApp({ public: true })` serves `app.public`. The platform mounts that router below
 * `PUBLIC_SURFACE_PREFIX` on the app upstream. Only the gateway sends requests there, for a host an
 * administrator assigned to the app, and sets `PUBLIC_HOST_HEADER` to the request authority (that host plus the
 * client's port, if its Host header had one). The gateway strips both
 * the prefix and the header from every incoming request on every host.
 */
export const PUBLIC_SURFACE_PREFIX = "/_cloud/public";
export const PUBLIC_HOST_HEADER = "X-Cloud-Public-Host";

/** The only Cloud path on an app domain: `GET <prefix><nonce>` answers the nonce while Core checks the domain. */
export const DOMAIN_CHECK_PATH_PREFIX = "/_cloud/domain-check/";
/** Valkey key Core sets (value "1", TTL `DOMAIN_CHECK_TTL_SECONDS`) before it requests the check path. */
export const domainCheckKey = (host: string, nonce: string): string => `cloud:domain-check:${host}:${nonce}`;
export const DOMAIN_CHECK_TTL_SECONDS = 60;

export type AppDomain = {
  /** Normalized host: lowercase ASCII (IDNA), no port, no wildcard. */
  host: string;
  appId: string;
  /** Another domain of the same app; requests then answer 301 (GET/HEAD) or 308 with path and query kept. */
  redirectTo: string | null;
  createdAt: string;
};

/** Durable assignment, owned by Core's migration. Readers before that migration see no table and no domains. */
export const APP_DOMAINS_DDL = `
  CREATE TABLE IF NOT EXISTS settings.app_domains (
    host TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    redirect_to TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Returns the normalized host, or null when `input` is not a single DNS host name without port or wildcard. */
export const normalizeAppDomainHost = (input: string): string | null => {
  const trimmed = input.trim().replace(/\.$/, "");
  if (!trimmed || /[/:@?#*\s]/.test(trimmed)) return null;
  let host: string;
  try {
    host = new URL(`http://${trimmed}`).hostname;
  } catch {
    return null;
  }
  if (host.length > 253 || /^\d+(\.\d+){3}$/.test(host) || host.startsWith("[")) return null;
  const labels = host.split(".");
  if (labels.length < 2 && !host.endsWith("localhost")) return null;
  return labels.every((label) => HOST_LABEL.test(label)) ? host : null;
};

/** Reads all assignments. A database without Core's table yet has none. */
export const readAppDomains = async (db: SQL): Promise<AppDomain[]> => {
  try {
    const rows = await db<{ host: string; app_id: string; redirect_to: string | null; created_at: Date }[]>`
      SELECT host, app_id, redirect_to, created_at FROM settings.app_domains ORDER BY host
    `;
    return rows.map((row) => ({ host: row.host, appId: row.app_id, redirectTo: row.redirect_to, createdAt: row.created_at.toISOString() }));
  } catch (error) {
    const code = error && typeof error === "object" && "errno" in error ? String(error.errno) : "";
    if (code === "42P01") return [];
    throw error;
  }
};

/** Whether a registry entry declares `public: true`, read structurally so older entries stay valid. */
export const declaresPublicSurface = (entry: object): boolean => "public" in entry && entry.public === true;

/** Cookies that carry a Cloud credential. The gateway removes them from every request to a public surface. */
export const isCloudCredentialCookie = (name: string): boolean =>
  name === "session_token" ||
  name === PWA_COOKIES.session ||
  name === PWA_COOKIES.device ||
  name === PWA_COOKIES.pairing ||
  name === "cloud_browser" ||
  name === "__Host-cloud_browser" ||
  name.startsWith("__Secure-cloud-app-pwa-");
