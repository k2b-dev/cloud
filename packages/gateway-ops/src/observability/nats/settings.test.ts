import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { toLegacySettingDefs, validateSettingValue } from "@k2b/cloud/services/settings/defaults";
import { writeKey } from "@k2b/cloud/services/settings/store";
import { stubConnections } from "../../../../../scripts/fixtures/platform";
import { app } from "../../config";
import { natsMetricSamples } from "./metrics";
import { getNatsClusterDiagnostics, type NatsDiagnosticsDependencies, natsDiagnosticsConfig } from "./service";
import { credsContentAuthenticator, natsDiagnosticsBootstrap, natsDiagnosticsSettings, systemAccessKind } from "./settings";

// Fixed, synthetic user identity, never used by an installation.
const seed = "SUAKUXPEVUSGATY3QL7DLSWRPVMI2BJTSIBBYDT36YKPKKAFQYVMXHVVDA";
const publicKey = "UDIUJUDLO34HMQIYRXGNNAKMV7ZWKG5QWUCPEBTKJ6SLCWIJAAR6EMRX";
const jwt = `${Buffer.from('{"alg":"ed25519-nkey","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: publicKey })).toString("base64url")}.fixture`;
const creds = `-----BEGIN NATS USER JWT-----\n${jwt}\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\n${seed}\n------END USER NKEY SEED------`;
const names = ["NATS_ADMIN_SERVERS", "NATS_ADMIN_CREDS_FILE", "NATS_ADMIN_NKEY_SEED_FILE", "NATS_ADMIN_TLS_CA_FILE"];
const original = new Map(names.map((name) => [name, process.env[name]]));
const directory = mkdtempSync(join(tmpdir(), "cloud-nats-settings-"));
const definitions = toLegacySettingDefs(natsDiagnosticsSettings);
const definition = (key: string) => definitions.find((def) => def.key === key)!;

const applicationNats = {
  servers: ["nats://application"],
  namespace: "test-unit",
  replicas: 1 as const,
  ignoreClusterUpdates: true,
  creds: "application-credentials-content",
  ca: "application-ca-content",
};
let connection: ReturnType<typeof stubConnections>;
beforeEach(() => {
  connection = stubConnections({ nats: applicationNats });
});

for (const name of names) delete process.env[name];
afterEach(() => {
  connection.mockRestore();
  for (const name of names) delete process.env[name];
});
// Register separately so failures also restore the caller's environment and files.
afterAll(() => {
  for (const [name, value] of original) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

test("bootstrap imports file contents and selects the matching access format", () => {
  const path = join(directory, "system.creds");
  const caPath = join(directory, "ca.pem");
  writeFileSync(path, creds);
  writeFileSync(caPath, rootCertificates[0]!);
  process.env.NATS_ADMIN_SERVERS = "tls://nats.example:4222";
  process.env.NATS_ADMIN_CREDS_FILE = path;
  process.env.NATS_ADMIN_TLS_CA_FILE = caPath;
  expect(natsDiagnosticsBootstrap()).toEqual({
    servers: ["tls://nats.example:4222"],
    kind: "creds",
    access: creds,
    ca: rootCertificates[0]!.trim(),
  });
  expect(definition("gateway.nats_admin_access").envBootstrap?.()).toBe(creds);
  delete process.env.NATS_ADMIN_CREDS_FILE;
  const seedPath = join(directory, "system.seed");
  writeFileSync(seedPath, `${seed}\n`);
  process.env.NATS_ADMIN_NKEY_SEED_FILE = seedPath;
  expect(natsDiagnosticsBootstrap()).toMatchObject({ kind: "nkey", access: seed });
  expect(systemAccessKind(seed)).toBe("nkey");
  expect(systemAccessKind(creds)).toBe("creds");
});

test("unreadable files warn with the variable and path and prevent a partial bootstrap", () => {
  const path = join(directory, "missing.creds");
  process.env.NATS_ADMIN_CREDS_FILE = path;
  process.env.NATS_ADMIN_SERVERS = "nats://system.example:4222";
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(() => definition("gateway.nats_admin_servers").envBootstrap?.()).toThrow("Cannot import NATS_ADMIN_CREDS_FILE");
    expect(warn).toHaveBeenCalledWith(
      `[settings] cannot import NATS_ADMIN_CREDS_FILE from "${path}"; NATS diagnostics bootstrap is disabled`,
    );
  } finally {
    warn.mockRestore();
  }
});

test("conflicting files and invalid file contents cannot bootstrap diagnostics", () => {
  process.env.NATS_ADMIN_CREDS_FILE = "system.creds";
  process.env.NATS_ADMIN_NKEY_SEED_FILE = "system.seed";
  expect(natsDiagnosticsBootstrap).toThrow("Conflicting NATS diagnostics access files");
  delete process.env.NATS_ADMIN_NKEY_SEED_FILE;
  const path = join(directory, "invalid.creds");
  writeFileSync(path, "invalid .creds content");
  process.env.NATS_ADMIN_CREDS_FILE = path;
  expect(natsDiagnosticsBootstrap).toThrow("Invalid NATS_ADMIN_CREDS_FILE");
});

test("write validation rejects malformed credentials and PEM before reaching storage", async () => {
  for (const invalid of ["not credentials", "SUinvalid", creds.replace(seed, "SUinvalid"), creds.replace(jwt, "not-a-jwt")]) {
    expect(validateSettingValue(definition("gateway.nats_admin_access"), invalid).ok).toBe(false);
    await expect(writeKey("gateway.nats_admin_access", invalid)).rejects.toThrow("System access must contain");
  }
  for (const invalid of [
    "/run/secrets/ca.pem",
    "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----",
    `${rootCertificates[0]}\nprivate content`,
  ]) {
    await expect(writeKey("gateway.nats_admin_tls_ca", invalid)).rejects.toThrow("TLS CA must contain");
  }
  expect(validateSettingValue(definition("gateway.nats_admin_tls_ca"), rootCertificates[0]).ok).toBe(true);
  expect(validateSettingValue(definition("gateway.nats_admin_tls_ca"), `${rootCertificates[0]}\n${rootCertificates[1]}`).ok).toBe(true);
  expect(validateSettingValue(definition("gateway.nats_admin_access"), seed).ok).toBe(true);
  expect(validateSettingValue(definition("gateway.nats_admin_access"), creds).ok).toBe(true);
});

const readConfig = async (
  kind = "creds",
  access = "",
  stored: "none" | "readable" | "unreadable" = "readable",
  servers = ["nats://system"],
) => {
  const read = spyOn(app.settings, "read");
  read.mockResolvedValueOnce({ value: servers, stored: "readable" });
  read.mockResolvedValueOnce({ value: kind, stored: "readable" });
  read.mockResolvedValueOnce({ value: access, stored });
  read.mockResolvedValueOnce({ value: "", stored: "none" });
  try {
    return await natsDiagnosticsConfig();
  } finally {
    read.mockRestore();
  }
};

test("connection configuration reads fresh settings and honors format switches", async () => {
  const config = await readConfig("creds", creds);
  expect(config.admin).toMatchObject({ servers: ["nats://system"], creds });
  expect(config.application).toEqual({
    servers: applicationNats.servers,
    creds: applicationNats.creds,
    tlsCa: applicationNats.ca,
  });
  expect((await readConfig("nkey", seed)).admin).toMatchObject({ servers: ["nats://system"], seed });
  expect((await readConfig("nkey", creds)).admin.servers).toEqual([]);
  expect((await readConfig("creds", seed)).admin.servers).toEqual([]);
  expect((await readConfig("creds", "", "unreadable")).admin.servers).toEqual([]);
});

test("without settings cluster diagnostics stay off and never connect", async () => {
  const config = await readConfig("creds", "", "none", []);
  let calls = 0;
  const dependencies: NatsDiagnosticsDependencies = {
    connect: async () => {
      calls++;
      throw new Error("must not connect");
    },
  };
  expect(await getNatsClusterDiagnostics(config, dependencies)).toEqual({ status: "not_configured", nodes: [] });
  expect(calls).toBe(0);
});

test("a settings outage marks cluster diagnostics unavailable without connecting", async () => {
  const read = spyOn(app.settings, "read").mockRejectedValue(new Error("database unavailable"));
  try {
    const config = await natsDiagnosticsConfig();
    expect(config.adminSettingsUnavailable).toBe(true);
    const cluster = await getNatsClusterDiagnostics(config);
    expect(cluster).toMatchObject({ status: "unavailable", nodes: [] });
    const metrics = natsMetricSamples(cluster, { status: "available", streams: [], total: 0, sampledAt: "2026-10-30T00:00:00.000Z" });
    expect(metrics.some((metric) => metric.name === "cloud_nats_cluster_configured")).toBe(false);
    expect(metrics.find((metric) => metric.name === "cloud_nats_cluster_up")?.value).toBe(0);
    expect(metrics.find((metric) => metric.name === "cloud_nats_inventory_up")?.value).toBe(1);
    expect(config.application).toBeDefined();
  } finally {
    read.mockRestore();
  }
});

test("credentials without a trailing newline remain usable at the transport boundary", () => {
  expect(credsContentAuthenticator(creds)("fixture-nonce")).toMatchObject({ jwt, nkey: publicKey });
});
