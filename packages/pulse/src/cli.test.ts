import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises";
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
  metricFilters: [],
  status: {
    newestDataAt: "2026-07-07T00:00:00.000Z",
    throttled: false,
    throttledAt: null,
    refusedHistograms: [],
    skippedSummaries: 0,
    lastError: null,
    lastErrorAt: null,
  },
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

  test.each(["text", "json", "jsonl"] as const)(
    "#11 token creation writes a private file without printing the token (%s)",
    async (output) => {
      const directory = await mkdtemp(join(tmpdir(), "pulse-token-"));
      const path = join(directory, "token");
      try {
        const { ctx, calls, lines } = createContext(
          ["source-tokens", "create", baseId, "docker"],
          { name: "docker-host", "output-file": path },
          [jsonResponse(base), jsonResponse([source]), jsonResponse({ credential: sourceToken, token: "secret-token" }, 201)],
          output,
        );
        await pulseCli.run(ctx);
        expect(calls[2]?.init?.method).toBe("POST");
        expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ name: "docker-host", permission: "write", expiresAt: null });
        expect(await readFile(path, "utf8")).toBe("secret-token");
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(lines.join("\n")).not.toContain("secret-token");
        expect(lines.join("\n")).toContain(path);
        if (output !== "text") expect(JSON.parse(lines[0]!)).toEqual({ id: sourceToken.id, name: sourceToken.name, path });
        const second = createContext(["source-tokens", "create", baseId, "docker"], { name: "other", "output-file": path }, [
          jsonResponse(base),
          jsonResponse([source]),
        ]);
        await expect(pulseCli.run(second.ctx)).rejects.toThrow("EEXIST");
        expect(second.calls).toHaveLength(2);
        expect(await readFile(path, "utf8")).toBe("secret-token");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("#11 token creation requires --output-file before making API calls", async () => {
    const { ctx, calls } = createContext(["source-tokens", "create", baseId, "docker"], { name: "docker-host" });
    await expect(pulseCli.run(ctx)).rejects.toThrow("--output-file");
    expect(calls).toHaveLength(0);
  });

  test("#12 source CLI sends repeated filters and can clear them", async () => {
    const create = createContext(
      ["sources", "create", baseId],
      { name: "filtered", kind: "metrics", "endpoint-url": "https://example.org/metrics", "metric-filter": ["node_*", "up"] },
      [jsonResponse(base), jsonResponse(source)],
    );
    await pulseCli.run(create.ctx);
    expect(JSON.parse(String(create.calls[1]?.init?.body)).metricFilters).toEqual(["node_*", "up"]);
    const update = createContext(["sources", "update", baseId, "docker"], { "clear-metric-filters": true }, [
      jsonResponse(base),
      jsonResponse([source]),
      jsonResponse(source),
    ]);
    await pulseCli.run(update.ctx);
    expect(JSON.parse(String(update.calls[2]?.init?.body)).metricFilters).toEqual([]);
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
  const { default: api } = await import("./api/index");
  const path = calls.at(-1)!.path.replace(/^\/api\/pulse/, "");
  expect(api.router.match("POST", path)[0].some(([[, route]]) => route.method === "POST")).toBe(true);
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

test("the removed deployment snapshot command makes no API call", async () => {
  const { ctx, calls } = createContext(["capabilities"]);
  await expect(pulseCli.run(ctx)).rejects.toThrow("Unknown pulse command");
  expect(calls).toHaveLength(0);
});

describe("Pulse SQL CLI", () => {
  const result = {
    runId: "00000000-0000-4000-8000-000000000001",
    columns: [{ name: "text", type: "String" }],
    rows: [['a,"b']],
    rowCount: 1,
    truncated: false,
    stats: { elapsedMs: 1, readRows: 1, readBytes: 4 },
    limits: {},
  };
  test.each(["table", "json", "csv"])("prints %s and binds parameter values as data", async (format) => {
    const context = createContext(["sql", "SELECT :value"], { base: baseId, param: ['value=a,\"b'], format }, [jsonResponse(result)]);
    expect(await pulseCli.run(context.ctx)).toBe(0);
    expect(context.calls[0]?.path).toBe(`/api/pulse/bases/${baseId}/sql`);
    const body = JSON.parse(String(context.calls[0]?.init?.body));
    expect(body.params).toEqual({ value: 'a,"b' });
    expect(body.runId).toMatch(/^[a-f0-9-]{36}$/);
    if (format === "json") expect(JSON.parse(context.lines[0]!)).toEqual(result);
    else if (format === "csv") expect(context.lines).toEqual(["text", '"a,""b"']);
    else expect(context.tables).toEqual([[{ 0: 'a,"b' }]]);
  });
  test("reads SQL from a file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pulse-sql-cli-"));
    const path = join(directory, "query.sql");
    await Bun.write(path, "SELECT :metric");
    try {
      const context = createContext(["sql"], { base: baseId, file: path, param: ["metric=cpu"] }, [jsonResponse(result)]);
      expect(await pulseCli.run(context.ctx)).toBe(0);
      expect(JSON.parse(String(context.calls[0]?.init?.body)).sql).toBe("SELECT :metric");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("reads SQL from stdin", async () => {
    const { spyOn } = await import("bun:test");
    const stdin = spyOn(Bun.stdin, "text").mockResolvedValue("SELECT 1");
    try {
      const context = createContext(["sql", "-"], { base: baseId }, [jsonResponse(result)]);
      expect(await pulseCli.run(context.ctx)).toBe(0);
      expect(JSON.parse(String(context.calls[0]?.init?.body)).sql).toBe("SELECT 1");
    } finally {
      stdin.mockRestore();
    }
  });
  test.each([
    ["INPUT_TOO_LARGE", 2],
    ["PARAMETER_MISSING", 2],
    ["SQL_ERROR", 3],
    ["TIME_LIMIT", 4],
    ["MEMORY_LIMIT", 4],
    ["RESULT_TOO_LARGE", 4],
    ["BUSY", 5],
    ["QUEUE_FULL", 5],
    ["QUOTA", 5],
    ["NO_READ_ACCESS", 6],
    ["STORE_UNAVAILABLE", 7],
  ] as const)("maps %s to exit %s", async (code, expected) => {
    const context = createContext(["sql", "SELECT 1"], { base: baseId }, [jsonResponse({ code, message: "Query refused." }, 400)]);
    expect(await pulseCli.run(context.ctx)).toBe(expected);
    expect(context.lines).toEqual([`${code}: Query refused.`]);
  });
  test("rejects invalid input before any HTTP request", async () => {
    const context = createContext(["sql", "SELECT :missing"], { base: baseId });
    expect(await pulseCli.run(context.ctx)).toBe(2);
    expect(context.calls).toHaveLength(0);
    expect(context.lines.join()).toContain("PARAMETER_MISSING");
  });
  test("unknown upstream failures never print credentials or response bodies", async () => {
    const context = createContext(["sql", "SELECT 1"], { base: baseId }, [
      jsonResponse({ code: "REMOTE", message: "SECRET_MUST_NOT_PRINT" }, 500),
    ]);
    expect(await pulseCli.run(context.ctx)).toBe(7);
    expect(context.lines.join()).not.toContain("SECRET_MUST_NOT_PRINT");
    expect(context.lines.join()).not.toContain(context.ctx.options.token);
  });
  test.each([true, false])("Ctrl-C cancels visibly even if the response races the abort (transport rejects: %s)", async (rejects) => {
    const context = createContext(["sql", "SELECT 1"], { base: baseId });
    let sent: Record<string, unknown> | undefined;
    context.ctx.fetch = async (path, init) => {
      context.calls.push({ path, init });
      if (path.endsWith("/cancel")) {
        sent = JSON.parse(String(init?.body));
        return jsonResponse({ cancelled: true });
      }
      // Emitting immediately exercises cancellation before the first response byte.
      process.emit("SIGINT");
      expect(init?.signal?.aborted).toBe(true);
      if (rejects) throw new DOMException("Aborted", "AbortError");
      return jsonResponse(result);
    };
    expect(await pulseCli.run(context.ctx)).toBe(130);
    const request = JSON.parse(String(context.calls[0]?.init?.body));
    expect(sent).toEqual({ runId: request.runId });
    expect(context.calls[1]?.path).toBe(`/api/pulse/bases/${baseId}/sql/cancel`);
    expect(context.lines).toContain("CANCELLED: Query cancelled.");
  });
  test.each(["sql", "queries list", "queries get", "queries save", "queries delete"])("help for %s sends no request", async (command) => {
    const context = createContext([...command.split(" "), "--help"]);
    await pulseCli.run(context.ctx);
    expect(context.calls).toHaveLength(0);
    expect(context.lines.length).toBeGreaterThan(0);
  });
});

describe("Pulse saved query CLI", () => {
  const query = {
    id: "Query1",
    baseId,
    name: "Count",
    sql: "SELECT 1",
    params: {},
    revision: 2,
    createdBy: userId,
    updatedBy: userId,
    createdAt: "2026-10-20T10:00:00Z",
    updatedAt: "2026-10-20T10:00:00Z",
  };
  test("lists a bounded page", async () => {
    const context = createContext(["queries", "list"], { base: baseId, page: "2", "per-page": "5" }, [
      jsonResponse({ items: [query], total: 6, nextOffset: null }),
    ]);
    await pulseCli.run(context.ctx);
    expect(context.calls[0]?.path).toBe(`/api/pulse/bases/${baseId}/queries?limit=5&offset=5`);
  });
  test("saves an update with its expected revision and retry key", async () => {
    const context = createContext(
      ["queries", "save", "SELECT 1"],
      { base: baseId, name: "Count", query: "Query1", "expected-revision": "1", "idempotency-key": "fixture-save" },
      [jsonResponse(query)],
    );
    await pulseCli.run(context.ctx);
    expect(context.calls[0]?.init?.method).toBe("PATCH");
    expect(new Headers(context.calls[0]?.init?.headers).get("Idempotency-Key")).toBe("fixture-save");
    expect(JSON.parse(String(context.calls[0]?.init?.body))).toEqual({ name: "Count", sql: "SELECT 1", params: {}, expectedRevision: 1 });
  });
  test("delete sends the revision that was confirmed", async () => {
    const context = createContext(["queries", "delete", "Query1"], { base: baseId, "expected-revision": "2", yes: true }, [
      jsonResponse({ deleted: true }),
    ]);
    await pulseCli.run(context.ctx);
    expect(context.calls[0]?.init?.method).toBe("DELETE");
    expect(JSON.parse(String(context.calls[0]?.init?.body))).toEqual({ expectedRevision: 2 });
  });
  test("delete needs confirmation", async () => {
    const context = createContext(["queries", "delete", "Query1"], { base: baseId, "expected-revision": "1" });
    await expect(pulseCli.run(context.ctx)).rejects.toThrow("without --yes");
    expect(context.calls).toHaveLength(0);
  });
});
