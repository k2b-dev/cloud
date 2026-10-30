import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import * as server from "@k2b/cloud/server";
import { settings, settingsService } from "@k2b/cloud/services";
import { session } from "@k2b/cloud/services/session";
import { buildProjectedUser } from "@k2b/cloud/services/session/user";
import { registerSettings, SETTINGS } from "@k2b/cloud/services/settings/defaults";
import { sql } from "bun";
import { suiteFor, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { app } from "../../config";
import { getNatsClusterDiagnostics, natsDiagnosticsConfig } from "./service";
import { natsDiagnosticsSettings } from "./settings";

const suite = suiteFor("database", "valkey");
suite("NATS diagnostics settings startup import", () => {
  const variables = [
    "APP_URL",
    "GOTENBERG_URL",
    "NATS_ADMIN_SERVERS",
    "NATS_ADMIN_CREDS_FILE",
    "NATS_ADMIN_NKEY_SEED_FILE",
    "NATS_ADMIN_TLS_CA_FILE",
  ];
  const previous = new Map(variables.map((key) => [key, process.env[key]]));
  const seed = "SUAKUXPEVUSGATY3QL7DLSWRPVMI2BJTSIBBYDT36YKPKKAFQYVMXHVVDA";
  let directory: string;
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  beforeAll(async () => {
    for (const variable of variables) delete process.env[variable];
    database = await useFreshDatabase("cloud_nats_access_endpoint");
    await sql`CREATE SCHEMA settings`;
    await sql`CREATE TABLE settings.entries (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`;
    directory = mkdtempSync(join(tmpdir(), "cloud-nats-bootstrap-"));
    writeFileSync(join(directory, "system.seed"), seed);
    writeFileSync(join(directory, "ca.pem"), rootCertificates[0]!);
    process.env.NATS_ADMIN_SERVERS = "tls://system.example:4222";
    process.env.NATS_ADMIN_NKEY_SEED_FILE = join(directory, "system.seed");
    process.env.NATS_ADMIN_TLS_CA_FILE = join(directory, "ca.pem");
  });
  afterAll(async () => {
    try {
      for (const key of Object.keys(natsDiagnosticsSettings)) await settings.remove(key);
    } finally {
      if (directory) rmSync(directory, { recursive: true, force: true });
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await database?.drop();
    }
  });

  test("imports encrypted contents once, preserves stored values, and reconnects without files", async () => {
    expect(
      SETTINGS.filter((def) => !def.key.startsWith("gateway.nats_admin_") && def.envBootstrap?.() !== undefined).map((def) => def.key),
    ).toEqual([]);
    await sql`ALTER TABLE settings.entries ADD CONSTRAINT delay_ca CHECK (key <> 'gateway.nats_admin_tls_ca')`;
    await expect(settings.loadCache()).rejects.toThrow("delay_ca");
    expect(await sql`SELECT key FROM settings.entries WHERE key LIKE 'gateway.nats_admin_%'`).toHaveLength(0);
    expect(await sql`SELECT key FROM settings.entries WHERE key = 'gateway.nats_admin_servers'`).toHaveLength(0);
    expect((await natsDiagnosticsConfig()).admin.servers).toEqual([]);
    await sql`ALTER TABLE settings.entries DROP CONSTRAINT delay_ca`;

    await settings.loadCache();
    expect(await app.settings.get("gateway.nats_admin_access")).toBe(seed);
    expect(await app.settings.get("gateway.nats_admin_access_kind")).toBe("nkey");
    expect(await app.settings.get("gateway.nats_admin_tls_ca")).toBe(rootCertificates[0]!.trim());
    const [row] = await sql<{ value: string }[]>`SELECT value FROM settings.entries WHERE key = 'gateway.nats_admin_access'`;
    expect(row?.value).toBeDefined();
    expect(row?.value).not.toContain(seed);
    expect(row?.value).not.toContain(directory);

    await app.settings.set("gateway.nats_admin_servers", ["tls://saved.example:4222"]);
    expect(await app.settings.get("gateway.nats_admin_access")).toBe("");
    await app.settings.set("gateway.nats_admin_access", seed);
    rmSync(directory, { recursive: true });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await settings.loadCache();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    for (const variable of variables) delete process.env[variable];
    const config = await natsDiagnosticsConfig();
    expect(config.admin).toEqual({ servers: ["tls://saved.example:4222"], seed, tlsCa: rootCertificates[0]!.trim() });
  });
  test("admin settings API changes discard stored access and never dial new servers with old access", async () => {
    const oldServers = ["tls://old.example:4222"];
    const newServers = ["tls://new.example:4222"];
    await app.settings.set("gateway.nats_admin_servers", oldServers);
    await app.settings.set("gateway.nats_admin_access_kind", "nkey");
    await app.settings.set("gateway.nats_admin_access", seed);
    expect((await natsDiagnosticsConfig()).admin).toMatchObject({ servers: oldServers, seed });
    const limit = spyOn(server, "rateLimit").mockReturnValue(async (_c, next) => next());
    const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-02T03:04:05Z"));
    const user = buildProjectedUser({
      id: "00000000-0000-4000-8000-000000000001",
      provider: "local",
      profile: "user",
      effective_admin: true,
    });
    const authenticate = spyOn(session, "authenticateRequest").mockResolvedValue({
      user,
      data: {
        userId: user.id,
        sid: "test",
        authEpoch: 0,
        kind: "web",
        expiresAt: "2026-01-03T03:04:05.000Z",
      },
    });
    try {
      const { apiRoutes } = await import("../../api");
      const response = await apiRoutes.request("/settings/gateway.nats_admin_servers", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: "session_token=test" },
        body: JSON.stringify({ value: newServers }),
      });
      expect(response.status).toBe(200);
    } finally {
      authenticate.mockRestore();
      clock.mockRestore();
      limit.mockRestore();
    }
    expect(await app.settings.get("gateway.nats_admin_access")).toBe("");
    const config = await natsDiagnosticsConfig();
    let calls = 0;
    await getNatsClusterDiagnostics(config, {
      connect: async () => {
        calls++;
        throw new Error("must not dial");
      },
    });
    expect(calls).toBe(0);
    expect(config.adminAccessRequired).toBe(true);
    expect(config.admin).not.toHaveProperty("seed");
    // Going back must not resurrect the discarded access.
    await app.settings.set("gateway.nats_admin_servers", oldServers);
    expect(await app.settings.get("gateway.nats_admin_access")).toBe("");
  });

  test("unchanged normalized servers keep access; resets discard it", async () => {
    await app.settings.set("gateway.nats_admin_servers", ["tls://same.example:4222"]);
    await app.settings.set("gateway.nats_admin_access", seed);
    await settingsService.entry.update({ key: "gateway.nats_admin_servers", value: " tls://same.example:4222 " });
    expect(await app.settings.get("gateway.nats_admin_access")).toBe(seed);
    await app.settings.remove("gateway.nats_admin_servers");
    expect(await app.settings.get("gateway.nats_admin_access")).toBe("");
  });

  test("bootstrap never imports access for other stored servers or restores discarded access", async () => {
    directory = mkdtempSync(join(tmpdir(), "cloud-nats-bootstrap-"));
    writeFileSync(join(directory, "system.seed"), seed);
    process.env.NATS_ADMIN_SERVERS = "tls://environment.example:4222";
    process.env.NATS_ADMIN_NKEY_SEED_FILE = join(directory, "system.seed");
    await app.settings.set("gateway.nats_admin_servers", ["tls://stored.example:4222"]);
    // A genuinely missing access row may bootstrap only with matching servers.
    await app.settings.remove("gateway.nats_admin_access");
    await settings.loadCache();
    expect(await app.settings.get("gateway.nats_admin_access")).toBe("");
    expect((await natsDiagnosticsConfig()).adminAccessRequired).toBe(true);
    await app.settings.set("gateway.nats_admin_access", seed);
    await app.settings.set("gateway.nats_admin_servers", ["tls://environment.example:4222"]);
    await settings.loadCache();
    expect(await app.settings.get("gateway.nats_admin_access")).toBe("");
    for (const variable of variables) delete process.env[variable];
  });

  test("missing servers row cannot combine env servers with previously saved access", async () => {
    const oldServers = ["tls://old-stored.example:4222"];
    const newServers = ["tls://new-env.example:4222"];
    await app.settings.set("gateway.nats_admin_servers", oldServers);
    await app.settings.set("gateway.nats_admin_access_kind", "nkey");
    await app.settings.set("gateway.nats_admin_access", seed);
    // Reproduce the missing-row bootstrap path independently of the PUT hook.
    await sql`DELETE FROM settings.entries WHERE key = 'gateway.nats_admin_servers'`;
    process.env.NATS_ADMIN_SERVERS = newServers[0];
    const before = await natsDiagnosticsConfig();
    expect(before.admin).not.toHaveProperty("seed");
    await settings.loadCache();
    expect(await app.settings.get("gateway.nats_admin_servers")).toEqual(newServers);
    expect(await app.settings.get("gateway.nats_admin_access")).toBe("");
    const config = await natsDiagnosticsConfig();
    let calls = 0;
    await getNatsClusterDiagnostics(config, {
      connect: async () => {
        calls++;
        throw new Error("must not dial");
      },
    });
    expect(calls).toBe(0);
    expect(config.adminAccessRequired).toBe(true);
    delete process.env.NATS_ADMIN_SERVERS;
  });

  test("the saved access binding refuses a different server list even before any hook", async () => {
    await app.settings.set("gateway.nats_admin_servers", ["tls://bound.example:4222"]);
    await app.settings.set("gateway.nats_admin_access", seed);
    const [access] = await sql<{ value: string }[]>`SELECT value FROM settings.entries WHERE key = 'gateway.nats_admin_access'`;
    expect(access?.value).not.toContain(seed);
    // Simulate a row arriving outside the setting write path; binding still refuses it.
    const { encryptValue } = await import("@k2b/cloud/services/settings/crypto");
    const servers = await encryptValue(["tls://other.example:4222"]);
    await sql`UPDATE settings.entries SET value = ${servers} WHERE key = 'gateway.nats_admin_servers'`;
    expect((await natsDiagnosticsConfig()).admin).not.toHaveProperty("seed");
    expect(await app.settings.get("gateway.nats_admin_access")).toBe("");
  });
  test("explicit clear binds anonymous access to the current server list", async () => {
    await app.settings.set("gateway.nats_admin_servers", ["tls://anonymous.example:4222"]);
    expect((await natsDiagnosticsConfig()).adminAccessRequired).toBe(true);
    await app.settings.set("gateway.nats_admin_access", "");
    const config = await natsDiagnosticsConfig();
    expect(config.adminAccessRequired).toBe(false);
    expect(config.admin.servers).toEqual(["tls://anonymous.example:4222"]);
    await app.settings.set("gateway.nats_admin_servers", ["tls://changed.example:4222"]);
    expect((await natsDiagnosticsConfig()).adminAccessRequired).toBe(true);
  });
  test("a refused transaction keeps the previous endpoint and access together", async () => {
    const oldServers = ["tls://before-transaction.example:4222"];
    await app.settings.set("gateway.nats_admin_servers", oldServers);
    await app.settings.set("gateway.nats_admin_access", seed);
    await expect(
      sql.begin(async (tx) => {
        await settings.set("gateway.nats_admin_servers", ["tls://after-transaction.example:4222"], tx);
        expect((await natsDiagnosticsConfig()).admin).toMatchObject({ servers: oldServers, seed });
        throw new Error("refuse transaction");
      }),
    ).rejects.toThrow("refuse transaction");
    expect((await natsDiagnosticsConfig()).admin).toMatchObject({ servers: oldServers, seed });
  });

  test("unreadable servers refuse env access without preventing startup", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "cloud-nats-unreadable-"));
    writeFileSync(join(temporary, "system.seed"), seed);
    await app.settings.set("gateway.nats_admin_servers", ["tls://unreadable.example:4222"]);
    await app.settings.remove("gateway.nats_admin_access");
    await sql`UPDATE settings.entries SET value = 'unreadable-fixture' WHERE key = 'gateway.nats_admin_servers'`;
    process.env.NATS_ADMIN_SERVERS = "tls://env.example:4222";
    process.env.NATS_ADMIN_NKEY_SEED_FILE = join(temporary, "system.seed");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await settings.loadCache();
      expect((await app.settings.read("gateway.nats_admin_servers")).stored).toBe("unreadable");
      expect((await natsDiagnosticsConfig()).admin.servers).toEqual([]);
      expect(await app.settings.get("gateway.nats_admin_access")).toBe("");
    } finally {
      warn.mockRestore();
      delete process.env.NATS_ADMIN_SERVERS;
      delete process.env.NATS_ADMIN_NKEY_SEED_FILE;
      rmSync(temporary, { recursive: true });
      await app.settings.remove("gateway.nats_admin_servers");
    }
  });

  test("related environment values import together with servers declared first", async () => {
    const servers = "test.endpoint_binding_servers";
    const access = "test.endpoint_binding_access";
    let enabled = true;
    registerSettings([
      {
        key: servers,
        group: "test",
        kind: "string_list",
        default: [],
        description: "Endpoint bootstrap probe",
        resetOnChange: [access],
        envBootstrap: () => (enabled ? ["nats://probe.example:4222"] : undefined),
      },
      {
        key: access,
        group: "test",
        kind: "secret",
        default: "",
        description: "Access bootstrap probe",
        envBootstrap: () => (enabled ? "probe-access" : undefined),
      },
    ]);
    try {
      await settings.loadCache();
      expect(await settings.get<string>(access)).toBe("probe-access");
      expect(await settings.get<string[]>(servers)).toEqual(["nats://probe.example:4222"]);
      await settings.loadCache();
      expect(await settings.get<string>(access)).toBe("probe-access");
    } finally {
      enabled = false;
      await settings.remove(servers);
      await settings.remove(access);
    }
  });
});
