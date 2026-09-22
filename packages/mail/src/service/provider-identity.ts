import { sha256Json } from "./canonical";

/** The configured IMAP endpoint a binding is anchored to; TLS validation itself happens in the connector. */
export type ProviderEndpoint = { host: string; port: number; tlsMode: string };

/**
 * RFC 2971 IMAP ID fields that describe the server product and stay the same
 * across connections. Everything else the server reports is volatile:
 * `connection-token` and `remote-host` (Gmail) describe one session and the
 * client's egress address, `date`, `command`, `arguments` and `environment`
 * describe the running process, and `version`, `os` and `os-version` change
 * with routine provider upgrades that do not make it a different provider.
 */
const STABLE_SERVER_INFO_FIELDS = ["name", "vendor", "support-url"] as const;

type StableServerInfo = Partial<Record<(typeof STABLE_SERVER_INFO_FIELDS)[number], string>>;

const serverInfoOf = (serverIdentity: Record<string, unknown>): Record<string, unknown> => {
  const info = serverIdentity["serverInfo"];
  return info && typeof info === "object" && !Array.isArray(info) ? (info as Record<string, unknown>) : {};
};

/** The subset of a connector `serverIdentity` that identifies the provider product. */
export const stableServerInfo = (serverIdentity: Record<string, unknown>): StableServerInfo => {
  const info = serverInfoOf(serverIdentity);
  const stable: StableServerInfo = {};
  for (const field of STABLE_SERVER_INFO_FIELDS) {
    const value = info[field];
    if (typeof value === "string") stable[field] = value;
  }
  return stable;
};

const normalizeEndpoint = (endpoint: ProviderEndpoint) => ({
  host: endpoint.host.toLowerCase(),
  port: endpoint.port,
  tlsMode: endpoint.tlsMode,
});

/** Evidence version 2: endpoint plus the stable product fields. */
export const providerServerKey = (endpoint: ProviderEndpoint, serverIdentity: Record<string, unknown>): string =>
  sha256Json({ version: 2, ...normalizeEndpoint(endpoint), serverInfo: stableServerInfo(serverIdentity) });

/** Evidence version 1 hashed the complete IMAP ID response; kept only to recognise stored evidence. */
const legacyProviderServerKey = (endpoint: ProviderEndpoint, serverIdentity: Record<string, unknown>): string =>
  sha256Json({ ...normalizeEndpoint(endpoint), serverInfo: serverInfoOf(serverIdentity) });

export type ProviderEvidenceIdentity = { version: 1 | 2; serverKey: string; accountId: string };

export type EvidenceComparison = { state: "verified" | "different"; reason: string };

const SERVER_DIFFERS = "Provider server identity differs";

/**
 * Compares stored binding evidence with a freshly built candidate.
 *
 * Stored version-1 evidence is upgraded rather than trusted: the stored server
 * identities (remote resource and connection) are checked for the one that
 * reproduces the version-1 key, and only that identity's stable key is compared
 * with the candidate. A caller that persists the candidate on `verified`
 * thereby rewrites the evidence to version 2.
 */
export const compareProviderEvidence = (
  expected: ProviderEvidenceIdentity,
  candidate: ProviderEvidenceIdentity,
  legacy: { endpoint: ProviderEndpoint; storedIdentities: readonly Record<string, unknown>[] },
): EvidenceComparison => {
  let upgraded = false;
  if (expected.version === 1) {
    const source = legacy.storedIdentities.find((identity) => legacyProviderServerKey(legacy.endpoint, identity) === expected.serverKey);
    if (!source) return { state: "different", reason: `${SERVER_DIFFERS}; stored version 1 evidence matches no stored server identity` };
    if (providerServerKey(legacy.endpoint, source) !== candidate.serverKey) return { state: "different", reason: SERVER_DIFFERS };
    upgraded = true;
  } else if (expected.serverKey !== candidate.serverKey) {
    return { state: "different", reason: SERVER_DIFFERS };
  }
  if (expected.accountId !== candidate.accountId) return { state: "different", reason: "Authenticated provider account differs" };
  return {
    state: "verified",
    reason: upgraded
      ? "Provider server and authenticated account match; evidence upgraded from version 1"
      : "Provider server and authenticated account match",
  };
};
