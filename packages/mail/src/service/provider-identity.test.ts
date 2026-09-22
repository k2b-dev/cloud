import { describe, expect, test } from "bun:test";
import { sha256Json } from "./canonical";
import { compareProviderEvidence, type ProviderEndpoint, providerServerKey, stableServerInfo } from "./provider-identity";

const endpoint: ProviderEndpoint = { host: "imap.gmail.com", port: 993, tlsMode: "implicit" };

/** What Gmail reports in its IMAP ID response; the last two fields change per connection. */
const gmailIdentity = (session: { token: string; remoteHost: string }): Record<string, unknown> => ({
  host: endpoint.host,
  port: endpoint.port,
  tlsMode: endpoint.tlsMode,
  secureConnection: true,
  serverInfo: {
    name: "GImap",
    vendor: "Google, Inc.",
    "support-url": "https://support.google.com/mail",
    "remote-host": session.remoteHost,
    "connection-token": session.token,
  },
  advertisedCapabilities: ["IDLE", "IMAP4rev1"],
});

const first = gmailIdentity({ token: "token-one", remoteHost: "203.0.113.10" });
const second = gmailIdentity({ token: "token-two", remoteHost: "203.0.113.11" });

const evidence = (serverKey: string, accountId = "user@gmail.com", version: 1 | 2 = 2) => ({ version, serverKey, accountId });

/** The exact formula version-1 evidence used: endpoint plus the whole ID response. */
const legacyKey = (target: ProviderEndpoint, identity: Record<string, unknown>) =>
  sha256Json({ host: target.host.toLowerCase(), port: target.port, tlsMode: target.tlsMode, serverInfo: identity["serverInfo"] ?? {} });

describe("stableServerInfo", () => {
  test("keeps only the product fields of the IMAP ID response", () => {
    expect(stableServerInfo(first)).toEqual({ name: "GImap", vendor: "Google, Inc.", "support-url": "https://support.google.com/mail" });
    expect(stableServerInfo({ serverInfo: { name: "Dovecot", version: "2.3.21", os: "Linux", date: new Date() } })).toEqual({
      name: "Dovecot",
    });
    expect(stableServerInfo({})).toEqual({});
    expect(stableServerInfo({ serverInfo: null })).toEqual({});
  });
});

describe("compareProviderEvidence", () => {
  const legacy = { endpoint, storedIdentities: [] };

  test("a new connection token and client egress address are the same provider", () => {
    const expected = evidence(providerServerKey(endpoint, first));
    const candidate = evidence(providerServerKey(endpoint, second));
    expect(compareProviderEvidence(expected, candidate, legacy)).toEqual({
      state: "verified",
      reason: "Provider server and authenticated account match",
    });
  });

  test("a different endpoint is a different provider", () => {
    const expected = evidence(providerServerKey(endpoint, first));
    for (const changed of [{ host: "imap.example.com" }, { port: 143 }, { tlsMode: "starttls" }]) {
      const candidate = evidence(providerServerKey({ ...endpoint, ...changed }, first));
      expect(compareProviderEvidence(expected, candidate, legacy).state).toBe("different");
    }
    expect(
      compareProviderEvidence(expected, evidence(providerServerKey({ ...endpoint, host: "IMAP.GMAIL.COM" }, first)), legacy).state,
    ).toBe("verified");
  });

  test("a different server product or vendor is a different provider", () => {
    const expected = evidence(providerServerKey(endpoint, first));
    const other = { ...first, serverInfo: { ...(first["serverInfo"] as object), name: "Dovecot" } };
    expect(compareProviderEvidence(expected, evidence(providerServerKey(endpoint, other)), legacy)).toEqual({
      state: "different",
      reason: "Provider server identity differs",
    });
    const vendor = { ...first, serverInfo: { ...(first["serverInfo"] as object), vendor: "Someone else" } };
    expect(compareProviderEvidence(expected, evidence(providerServerKey(endpoint, vendor)), legacy).state).toBe("different");
  });

  test("a different authenticated account is rejected even on the same server", () => {
    const expected = evidence(providerServerKey(endpoint, first));
    const candidate = evidence(providerServerKey(endpoint, second), "other@gmail.com");
    expect(compareProviderEvidence(expected, candidate, legacy)).toEqual({
      state: "different",
      reason: "Authenticated provider account differs",
    });
  });

  test("stored version-1 evidence is upgraded when a stored identity reproduces it", () => {
    const expected = evidence(legacyKey(endpoint, first), "user@gmail.com", 1);
    const candidate = evidence(providerServerKey(endpoint, second));
    expect(
      compareProviderEvidence(expected, candidate, {
        endpoint,
        storedIdentities: [{ serverInfo: { name: "stale" } }, first],
      }),
    ).toEqual({
      state: "verified",
      reason: "Provider server and authenticated account match; evidence upgraded from version 1",
    });
  });

  test("stored version-1 evidence for a genuinely different server stays different", () => {
    const expected = evidence(legacyKey(endpoint, first), "user@gmail.com", 1);
    const dovecot = { serverInfo: { name: "Dovecot" } };
    expect(
      compareProviderEvidence(expected, evidence(providerServerKey(endpoint, dovecot)), { endpoint, storedIdentities: [first] }),
    ).toEqual({
      state: "different",
      reason: "Provider server identity differs",
    });
    // The endpoint moved after the evidence was written; no stored identity reproduces the old key.
    const moved = { ...endpoint, host: "imap.example.com" };
    expect(
      compareProviderEvidence(expected, evidence(providerServerKey(moved, first)), { endpoint: moved, storedIdentities: [first] }),
    ).toEqual({
      state: "different",
      reason: "Provider server identity differs; stored version 1 evidence matches no stored server identity",
    });
  });
});
