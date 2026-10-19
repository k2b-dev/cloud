import { describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudCliContext, CloudCliFlags, CloudCliOutputMode } from "@k2b/cloud/cli";
import pulseCli from "./cli";

type FetchCall = {
  path: string;
  init?: RequestInit;
};

const baseId = "Base01";
const sourceId = "Src001";
const userId = "33333333-3333-4333-8333-333333333333";
const accessId = "44444444-4444-4444-8444-444444444444";

const jsonResponse = (value: unknown, status = 200) => Response.json(value, { status });

const createContext = (args: string[], flags: CloudCliFlags = {}, responses: Response[] = [], output: CloudCliOutputMode = "text") => {
  const calls: FetchCall[] = [];
  const lines: string[] = [];
  const tables: unknown[][] = [];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "http://cloud.test", token: "token", output },
    getDefault: async () => undefined,
    setDefault: async () => undefined,
    createApiClient: (() => {
      throw new Error("not needed");
    }) as CloudCliContext["createApiClient"],
    fetch: async (path, init) => {
      calls.push({ path, init });
      const response = responses.shift();
      if (!response) throw new Error(`Unexpected fetch: ${path}`);
      return response;
    },
    readJson: async (response) => {
      const value = await response.json();
      if (!response.ok) throw new Error(`${response.status} ${typeof value?.message === "string" ? value.message : response.statusText}`);
      return value;
    },
    print: (value = "") => lines.push(value),
    write: async (value) => void lines.push(value),
    error: (value) => lines.push(value),
    json: (value) => lines.push(JSON.stringify(value, null, 2)),
    jsonLine: (value) => lines.push(JSON.stringify(value)),
    table: (rows) => tables.push(rows),
  };
  return { ctx, calls, lines, tables };
};

const base = {
  id: baseId,
  name: "Test",
  description: null,
  rawRetentionDays: 30,
  rollupRetentionDays: 365,
  sensitiveRetentionHours: 24,
  createdBy: null,
  deletionStartedAt: null,
  deletionFailedAt: null,
  deletionError: null,
  dataClearStartedAt: null,
  dataClearCompletedAt: null,
  dataClearFailedAt: null,
  dataClearError: null,
  createdAt: "2026-07-07T00:00:00.000Z",
  updatedAt: "2026-07-07T00:00:00.000Z",
};

const accessEntry = {
  id: accessId,
  principal: { type: "user" as const, userId },
  permission: "read",
  displayName: "Valentin Kolb",
  createdAt: "2026-07-07T00:00:00.000Z",
};

const sourceToken = {
  id: "55555555-5555-4555-8555-555555555555",
  serviceAccountId: "66666666-6666-4666-8666-666666666666",
  name: "docker-host",
  kind: "api_token" as const,
  status: "active" as const,
  tokenPrefix: "puls_1234",
  scopes: ["pulse:source:write"],
  permission: "write",
  expiresAt: null,
  lastUsedAt: null,
  createdBy: null,
  createdAt: "2026-07-07T00:00:00.000Z",
  revokedAt: null,
  revokedBy: null,
};

const source = {
  id: sourceId,
  baseId,
  kind: "http_ingest",
  name: "docker",
  enabled: true,
  endpointUrl: null,
  bearerTokenConfigured: false,
  scrapeIntervalSeconds: null,
  lastSeenAt: "2026-07-07T00:00:00.000Z",
  lastError: null,
  lastErrorAt: null,
  createdAt: "2026-07-07T00:00:00.000Z",
  updatedAt: "2026-07-07T00:00:00.000Z",
};

describe("pulse CLI", () => {
  test("resolves an exact six-character base name after an ID miss", async () => {
    const namedBase = { ...base, name: "Ops123" };
    const { ctx, calls, lines } = createContext(["get", "Ops123"], {}, [
      jsonResponse({ message: "Pulse resource not found" }, 404),
      jsonResponse([namedBase]),
    ]);

    await pulseCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual(["/api/pulse/bases/Ops123", "/api/pulse/bases"]);
    expect(lines[0]).toBe(`Ops123 (${baseId})`);
  });

  test("rejects an ambiguous exact six-character base name after an ID miss", async () => {
    const matches = [
      { ...base, id: "Base02", name: "Ops123" },
      { ...base, id: "Base03", name: "Ops123" },
    ];
    const { ctx } = createContext(["get", "Ops123"], {}, [
      jsonResponse({ message: "Pulse resource not found" }, 404),
      jsonResponse(matches),
    ]);

    await expect(pulseCli.run(ctx)).rejects.toThrow('Ambiguous Pulse base "Ops123". Use an ID.');
  });

  test("updates all V1 retention classes explicitly", async () => {
    const updated = {
      ...base,
      rawRetentionDays: 14,
      rollupRetentionDays: 730,
      sensitiveRetentionHours: 12,
    };
    const { ctx, calls, lines } = createContext(
      ["update", baseId],
      { "raw-retention-days": "14", "rollup-retention-days": "730", "sensitive-retention-hours": "12" },
      [jsonResponse(base), jsonResponse(updated)],
    );

    await pulseCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([`/api/pulse/bases/${baseId}`, `/api/pulse/bases/${baseId}`]);
    expect(calls[1]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      rawRetentionDays: 14,
      rollupRetentionDays: 730,
      sensitiveRetentionHours: 12,
    });
    expect(lines).toEqual([`Updated Pulse base Test (${baseId}).`]);
  });

  for (const output of ["text", "json"] as const)
    test(`shorter retention prints its preview and requires explicit confirmation (${output})`, async () => {
      const preview = [
        { kind: "raw", retention: 7, cutoff: "2026-10-10T12:00:00.000Z", rows: 25, bytes: 1024 },
        { kind: "sensitive", retention: 12, cutoff: "2026-10-17T00:00:00.000Z", rows: 5, bytes: 64 },
      ];
      const confirmation = { code: "PULSE_RETENTION_CONFIRMATION_REQUIRED", preview };
      const { ctx, calls, lines, tables } = createContext(
        ["update", baseId],
        { "raw-retention-days": "7", "sensitive-retention-hours": "12" },
        [jsonResponse(base), jsonResponse(confirmation, 409)],
        output,
      );
      await expect(pulseCli.run(ctx)).rejects.toThrow("--confirm-shorter-retention");
      expect(calls).toHaveLength(2);
      expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ rawRetentionDays: 7, sensitiveRetentionHours: 12 });
      if (output === "json") expect(JSON.parse(lines[0]!)).toEqual(confirmation);
      else expect(tables).toEqual([preview]);
    });

  test("shorter retention sends confirmation only with --confirm-shorter-retention", async () => {
    const { ctx, calls } = createContext(["update", baseId], { "raw-retention-days": "7", "confirm-shorter-retention": true }, [
      jsonResponse(base),
      jsonResponse({ ...base, rawRetentionDays: 7 }),
    ]);
    await pulseCli.run(ctx);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ rawRetentionDays: 7, confirmShorterRetention: true });
  });

  test("lists Pulse base access entries", async () => {
    const { ctx, calls, tables } = createContext(["access", "list", baseId], {}, [jsonResponse(base), jsonResponse([accessEntry])]);

    await pulseCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([`/api/pulse/bases/${baseId}`, `/api/pulse/bases/${baseId}/access`]);
    expect(tables[0]).toEqual([
      {
        accessId,
        principal: "Valentin Kolb",
        type: "user",
        permission: "read",
        createdAt: "2026-07-07T00:00:00.000Z",
      },
    ]);
  });

  test("grants Pulse base access through the base access endpoint", async () => {
    const { ctx, calls, lines } = createContext(["access", "grant", baseId], { user: userId, permission: "write" }, [
      jsonResponse(base),
      jsonResponse({ ...accessEntry, permission: "write" }, 201),
    ]);

    await pulseCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([`/api/pulse/bases/${baseId}`, `/api/pulse/bases/${baseId}/access`]);
    expect(calls[1]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      principal: { type: "user", userId },
      permission: "write",
    });
    expect(lines).toEqual(["Granted write on Test (Base01) to Valentin Kolb."]);
  });

  test("updates Pulse base access through the base access endpoint", async () => {
    const { ctx, calls, lines } = createContext(["access", "set", baseId], { "access-id": accessId, permission: "admin" }, [
      jsonResponse(base),
      jsonResponse({ message: "Access updated" }),
    ]);

    await pulseCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([`/api/pulse/bases/${baseId}`, `/api/pulse/bases/${baseId}/access/${accessId}`]);
    expect(calls[1]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ permission: "admin" });
    expect(lines).toEqual([`Updated ${accessId} to admin on Test (Base01).`]);
  });

  test("revokes Pulse base access through the base access endpoint", async () => {
    const { ctx, calls, lines } = createContext(["access", "revoke", baseId], { "access-id": accessId, yes: true }, [
      jsonResponse(base),
      jsonResponse({ message: "Access revoked" }),
    ]);

    await pulseCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([`/api/pulse/bases/${baseId}`, `/api/pulse/bases/${baseId}/access/${accessId}`]);
    expect(calls[1]?.init?.method).toBe("DELETE");
    expect(lines).toEqual([`Revoked access for ${accessId} on Test (Base01).`]);
  });

  test("lists source ingest tokens with explicit source-token command naming", async () => {
    const { ctx, calls, tables } = createContext(["source-tokens", "list", baseId, "docker"], {}, [
      jsonResponse(base),
      jsonResponse([source]),
      jsonResponse([sourceToken]),
    ]);

    await pulseCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/pulse/bases/${baseId}`,
      `/api/pulse/bases/${baseId}/sources`,
      `/api/pulse/bases/${baseId}/sources/${sourceId}/api-keys`,
    ]);
    expect(tables[0]).toEqual([
      {
        id: "55555555",
        name: "docker-host",
        prefix: "puls_1234",
        permission: "write",
        expiresAt: "-",
        lastUsedAt: "-",
        createdAt: "2026-07-07T00:00:00.000Z",
      },
    ]);
  });

  test("creates source ingest tokens through the source-token command group", async () => {
    const { ctx, calls, lines } = createContext(["source-tokens", "create", baseId, "docker"], { name: "docker-host" }, [
      jsonResponse(base),
      jsonResponse([source]),
      jsonResponse({ credential: sourceToken, token: "secret-token" }, 201),
    ]);

    await pulseCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/pulse/bases/${baseId}`,
      `/api/pulse/bases/${baseId}/sources`,
      `/api/pulse/bases/${baseId}/sources/${sourceId}/api-keys`,
    ]);
    expect(calls[2]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ name: "docker-host", permission: "write", expiresAt: null });
    expect(lines).toEqual([`Created token docker-host (${sourceToken.id}).`, "secret-token"]);
  });

  test("revokes source ingest tokens through the source-token command group", async () => {
    const { ctx, calls, lines } = createContext(["source-tokens", "revoke", baseId, "docker", "docker-host"], { yes: true }, [
      jsonResponse(base),
      jsonResponse([source]),
      jsonResponse([sourceToken]),
      jsonResponse({ message: "revoked" }),
    ]);

    await pulseCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/pulse/bases/${baseId}`,
      `/api/pulse/bases/${baseId}/sources`,
      `/api/pulse/bases/${baseId}/sources/${sourceId}/api-keys`,
      `/api/pulse/bases/${baseId}/sources/${sourceId}/api-keys/${sourceToken.id}`,
    ]);
    expect(calls[3]?.init?.method).toBe("DELETE");
    expect(lines).toEqual(["Revoked token docker-host."]);
  });

  test("streams list results as JSONL without rendering a table", async () => {
    const { ctx, lines, tables } = createContext(["list"], {}, [jsonResponse([base])], "jsonl");

    await pulseCli.run(ctx);

    expect(lines).toEqual([JSON.stringify({ ...base, permalink: "http://cloud.test/open/pulse.base/~Base01" })]);
    expect(tables).toEqual([]);
  });

  test("reads metrics bearer tokens from files without accepting inline secrets", async () => {
    const tokenFile = join(tmpdir(), `pulse-cli-token-${crypto.randomUUID()}`);
    await Bun.write(tokenFile, "scrape-secret\n");
    try {
      const { ctx, calls } = createContext(
        ["sources", "create", baseId],
        { name: "Prometheus", kind: "metrics", "endpoint-url": "https://metrics.example.test", "bearer-token-file": tokenFile },
        [jsonResponse(base), jsonResponse({ ...source, kind: "metrics", name: "Prometheus", bearerTokenConfigured: true }, 201)],
      );

      await pulseCli.run(ctx);

      expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
        kind: "metrics",
        name: "Prometheus",
        endpointUrl: "https://metrics.example.test",
        bearerToken: "scrape-secret",
        scrapeIntervalSeconds: null,
      });
    } finally {
      await unlink(tokenFile);
    }

    const { ctx: inline } = createContext(["sources", "create", baseId], {
      name: "Prometheus",
      kind: "metrics",
      "endpoint-url": "https://metrics.example.test",
      "bearer-token": "unsafe",
    });
    await expect(pulseCli.run(inline)).rejects.toThrow("Unknown flag: --bearer-token");
  });

  test("clears a configured metrics bearer token explicitly", async () => {
    const configuredSource = { ...source, kind: "metrics", bearerTokenConfigured: true };
    const { ctx, calls } = createContext(["sources", "update", baseId, "docker"], { "clear-bearer-token": true }, [
      jsonResponse(base),
      jsonResponse([configuredSource]),
      jsonResponse({ ...configuredSource, bearerTokenConfigured: false }),
    ]);

    await pulseCli.run(ctx);

    expect(JSON.parse(String(calls[2]?.init?.body))).toMatchObject({ bearerToken: null });
  });
});

test("ingests into an explicit source through the authenticated source endpoint", async () => {
  const batch = { events: [{ kind: "page.viewed" }] };
  const { ctx, calls } = createContext(["ingest", baseId], { source: sourceId, batch: JSON.stringify(batch) }, [
    jsonResponse(base),
    jsonResponse([source]),
    jsonResponse({ metrics: 0, events: 1, states: 0 }),
  ]);
  await pulseCli.run(ctx);
  expect(calls.at(-1)?.path).toBe(`/api/pulse/bases/${baseId}/sources/${sourceId}/ingest`);
  expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual(batch);
});

describe("Pulse data store administration", () => {
  const fixturePassword = "obviously-fake-cli-store-password";
  test("every admin command has help without fetching", async () => {
    for (const command of ["get", "set", "check", "setup-sql"]) {
      const context = createContext(["admin", "store", command, "--help"]);
      await pulseCli.run(context.ctx);
      expect(context.lines.join("\n")).toContain(`pulse admin store ${command}`);
      expect(context.calls).toHaveLength(0);
    }
  });
  test("setup-sql transports the file password only in the body and prints only salted SQL", async () => {
    const { buildSetupSql, hashServicePassword } = await import("./store/setup-sql");
    const path = join(tmpdir(), `pulse-store-cli-${crypto.randomUUID()}.password`);
    const hash = await hashServicePassword(fixturePassword);
    const sql = buildSetupSql({ user: "pulse_fixture", passwordSha256Hex: hash.sha256Hex, saltHex: hash.saltHex });
    await Bun.write(path, fixturePassword + "\n");
    try {
      const context = createContext(["admin", "store", "setup-sql"], { "password-file": path }, [jsonResponse({ sql })]);
      await pulseCli.run(context.ctx);
      expect(context.lines.join("\n")).toBe(sql);
      expect(context.lines.join("\n")).not.toContain(fixturePassword);
      expect(context.calls[0]?.path).toBe("/api/pulse/admin/store/setup-sql");
      expect(context.calls[0]?.path).not.toContain(fixturePassword);
      expect(JSON.parse(String(context.calls[0]?.init?.body))).toEqual({ password: fixturePassword });
    } finally {
      await unlink(path);
    }
  });
  test.each(["STORE_NOT_CONFIGURED", "PASSWORD_REQUIRED", "STORE_BUSY"])("a %s refusal names its code and fix", async (code) => {
    const { storeFixHint } = await import("./frontend/admin/messages");
    const context = createContext(["admin", "store", "check"], {}, [jsonResponse({ code }, code === "PASSWORD_REQUIRED" ? 400 : 409)]);
    await expect(pulseCli.run(context.ctx)).rejects.toThrow(`${code}: ${storeFixHint(code)}`);
  });
  test("an unknown refusal stays a generic request failure", async () => {
    const context = createContext(["admin", "store", "check"], {}, [jsonResponse({ code: "SOMETHING_REMOTE", message: "leak" }, 500)]);
    await expect(pulseCli.run(context.ctx)).rejects.toThrow("Pulse store request failed (500).");
  });
  for (const ok of [true, false])
    test(`store set --password-file has no secret output (ok=${ok})`, async () => {
      const path = join(tmpdir(), `pulse-store-cli-${crypto.randomUUID()}.password`);
      await Bun.write(path, fixturePassword + "\n");
      const status = {
        ok,
        ...(ok ? {} : { code: "AUTH_FAILED" }),
        checkedAt: "2026-10-17T12:00:00Z",
        steps: { reach: "ok", auth: ok ? "ok" : "failed", version: "skipped", rights: "skipped", profiles: "skipped" },
      };
      try {
        const context = createContext(
          ["admin", "store", "set"],
          { url: "http://fixture.invalid:8123", user: "pulse_fixture", "password-file": path },
          [
            jsonResponse(
              ok
                ? { configured: true, url: "http://fixture.invalid:8123", user: "pulse_fixture", passwordSet: true, status }
                : { code: "STORE_CHECK_FAILED", status },
              ok ? 200 : 422,
            ),
          ],
        );
        if (ok) await pulseCli.run(context.ctx);
        else await expect(pulseCli.run(context.ctx)).rejects.toThrow("AUTH_FAILED");
        expect(JSON.stringify(context.lines) + JSON.stringify(context.tables)).not.toContain(fixturePassword);
        expect(context.calls[0]?.path).not.toContain(fixturePassword);
        expect(JSON.parse(String(context.calls[0]?.init?.body)).password).toBe(fixturePassword);
      } finally {
        await unlink(path);
      }
    });
});

describe("Pulse base administration CLI", () => {
  test.each([
    { args: ["admin", "policy", "get"], flags: {}, path: "/api/pulse/admin/policy", method: undefined },
    {
      args: ["admin", "policy", "set"],
      flags: { "max-bases": "10", "default-values-per-minute": "100" },
      path: "/api/pulse/admin/policy",
      method: "PUT",
    },
    {
      args: ["admin", "bases", "list"],
      flags: { limit: "3", offset: "2", query: "ops" },
      path: "/api/pulse/admin/bases?limit=3&offset=2&q=ops",
      method: undefined,
    },
    {
      args: ["admin", "bases", "limits", "Base01"],
      flags: { profile: "small", "storage-bytes": "2000000000" },
      path: "/api/pulse/admin/bases/Base01/limits",
      method: "PUT",
    },
    ...["retry", "recheck", "recreate"].map((action) => ({
      args: ["admin", "bases", action, "Base01"],
      flags: action === "recreate" ? { yes: true } : {},
      path: `/api/pulse/admin/bases/Base01/${action}`,
      method: "POST",
    })),
    { args: ["admin", "orphans", "list"], flags: {}, path: "/api/pulse/admin/orphans", method: undefined },
    {
      args: ["admin", "orphans", "list"],
      flags: { limit: "3", after: "pulse_00000000000040008000000000000000" },
      path: "/api/pulse/admin/orphans?limit=3&after=pulse_00000000000040008000000000000000",
      method: undefined,
    },
    {
      args: ["admin", "orphans", "delete", "pulse_fixture"],
      flags: { yes: true },
      path: "/api/pulse/admin/orphans/pulse_fixture",
      method: "DELETE",
    },
    { args: ["admin", "targets", "list"], flags: { base: "Base01" }, path: "/api/pulse/admin/targets?baseId=Base01", method: undefined },
    { args: ["admin", "targets", "add", "web-01:9100"], flags: { base: "Base01" }, path: "/api/pulse/admin/targets", method: "POST" },
    { args: ["admin", "targets", "remove", "target-id"], flags: {}, path: "/api/pulse/admin/targets/target-id", method: "DELETE" },
  ])("routes $args to the admin API", async ({ args, flags, path, method }) => {
    const cleanFlags: CloudCliFlags = {};
    for (const [key, value] of Object.entries(flags)) if (value !== undefined) cleanFlags[key] = value;
    const { ctx, calls } = createContext([...args], cleanFlags, [jsonResponse({ ok: true })]);
    await pulseCli.run(ctx);
    expect(calls[0]?.path).toBe(path);
    expect(calls[0]?.init?.method).toBe(method);
  });
  test.each([{ args: ["admin", "bases", "recreate", "Base01"] }, { args: ["admin", "orphans", "delete", "pulse_fixture"] }])(
    "refuses the destructive $args without --yes",
    async ({ args }) => {
      const { ctx, calls } = createContext([...args], {}, [jsonResponse({ ok: true })]);
      await expect(pulseCli.run(ctx)).rejects.toThrow("without --yes");
      expect(calls).toHaveLength(0);
    },
  );
  test("fixed admin denial names the repair path without reflecting remote messages", async () => {
    const { ctx } = createContext(["admin", "policy", "get"], {}, [
      jsonResponse({ code: "ACCESS_DENIED", message: "REMOTE_MUST_NOT_LEAK" }, 403),
    ]);
    await expect(pulseCli.run(ctx)).rejects.toThrow("ACCESS_DENIED: A Cloud admin");
  });
});
