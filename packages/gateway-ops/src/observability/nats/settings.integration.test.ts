import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { settings } from "@k2b/cloud/services";
import { SETTINGS } from "@k2b/cloud/services/settings/defaults";
import { sql } from "bun";
import { suiteFor, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { app } from "../../config";
import { natsDiagnosticsConfig } from "./service";
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
    database = await useFreshDatabase("cloud_nats_diagnostics_setting");
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
});
