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
const dashboardId = "Dash01";
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

const inventory = {
  resources: [
    {
      key: "host:macbook",
      id: "macbook",
      label: "MacBook",
      type: "host",
      sourceIds: [sourceId],
      metricSeriesCount: 1,
      metricCount: 1,
      eventCount: 0,
      stateCount: 1,
      lastSeenAt: "2026-07-07T12:00:00.000Z",
      dimensions: { host: "macbook" },
    },
  ],
  metrics: [
    {
      seriesId: "33333333-3333-4333-8333-333333333333",
      resourceKey: "host:macbook",
      resourceId: "macbook",
      resourceType: "host",
      metric: "system.memory.usage",
      type: "gauge",
      unit: "percent",
      sourceId,
      dimensions: { host: "macbook" },
      lastSeenAt: "2026-07-07T12:00:00.000Z",
      latestValue: 61.2,
      latestSampleAt: "2026-07-07T12:00:00.000Z",
    },
  ],
  states: [
    {
      key: "system.host.online",
      value: true,
      sourceId,
      entityId: "host:macbook",
      entityType: "host",
      dimensions: { host: "macbook" },
      updatedAt: "2026-07-07T12:00:00.000Z",
    },
  ],
  events: [],
  fields: [
    {
      sourceId,
      scope: "event",
      signalName: "page.viewed",
      role: "attribute",
      key: "request_id",
      valueType: "string",
      observedCount: 42,
      firstSeenAt: "2026-07-07T11:00:00.000Z",
      lastSeenAt: "2026-07-07T12:00:00.000Z",
    },
  ],
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

  test("deletes a saved query by short ID without listing saved queries", async () => {
    const { ctx, calls } = createContext(["query", "delete", baseId, "Query1"], { yes: true }, [
      jsonResponse(base),
      jsonResponse({ message: "Query removed" }),
    ]);

    await pulseCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([`/api/pulse/bases/${baseId}`, `/api/pulse/bases/${baseId}/saved-queries/Query1`]);
    expect(calls[1]?.init?.method).toBe("DELETE");
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

  test("lists metrics for a resolved resource", async () => {
    const { ctx, calls, tables } = createContext(["resources", "metrics", baseId, "MacBook"], {}, [
      jsonResponse(base),
      jsonResponse(inventory.resources),
      jsonResponse(inventory.metrics),
    ]);

    await pulseCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/pulse/bases/${baseId}`,
      `/api/pulse/bases/${baseId}/resources?ref=MacBook&limit=20`,
      `/api/pulse/bases/${baseId}/resource-metrics?resourceKey=host%3Amacbook`,
    ]);
    expect(tables[0]).toEqual([
      {
        id: "33333333",
        metric: "system.memory.usage",
        type: "gauge",
        unit: "percent",
        source: "Src001",
        resource: "host:macbook",
        value: "61.2",
        lastSeenAt: "2026-07-07T12:00:00.000Z",
      },
    ]);
  });

  test("filters metric summaries by source name through the metrics endpoint", async () => {
    const { ctx, calls, tables } = createContext(["metrics", baseId], { source: "docker" }, [
      jsonResponse(base),
      jsonResponse([source]),
      jsonResponse([
        {
          name: "system.memory.usage",
          type: "gauge",
          unit: "percent",
          seriesCount: 1,
          lastSeenAt: "2026-07-07T12:00:00.000Z",
        },
      ]),
    ]);

    await pulseCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/pulse/bases/${baseId}`,
      `/api/pulse/bases/${baseId}/sources`,
      `/api/pulse/bases/${baseId}/metrics?sourceId=${sourceId}`,
    ]);
    expect(tables[0]).toEqual([
      {
        metric: "system.memory.usage",
        type: "gauge",
        unit: "percent",
        series: 1,
        lastSeenAt: "2026-07-07T12:00:00.000Z",
      },
    ]);
  });

  test("lists bounded field definitions by source and role", async () => {
    const { ctx, calls, tables } = createContext(["fields", "list", baseId], { source: "docker", role: "attribute", q: "request" }, [
      jsonResponse(base),
      jsonResponse([source]),
      jsonResponse(inventory.fields),
    ]);

    await pulseCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/pulse/bases/${baseId}`,
      `/api/pulse/bases/${baseId}/sources`,
      `/api/pulse/bases/${baseId}/fields?q=request&sourceId=${sourceId}&role=attribute&limit=100`,
    ]);
    expect(tables[0]).toEqual([
      {
        scope: "event",
        signal: "page.viewed",
        role: "attribute",
        field: "request_id",
        type: "string",
        source: "Src001",
        observations: 42,
        lastSeenAt: "2026-07-07T12:00:00.000Z",
      },
    ]);
  });

  test("filters metric summaries by resource through bounded resource endpoints", async () => {
    const { ctx, calls, tables } = createContext(["metrics", baseId], { resource: "MacBook" }, [
      jsonResponse(base),
      jsonResponse(inventory.resources),
      jsonResponse(inventory.metrics),
    ]);

    await pulseCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/pulse/bases/${baseId}`,
      `/api/pulse/bases/${baseId}/resources?ref=MacBook&limit=20`,
      `/api/pulse/bases/${baseId}/resource-metrics?resourceKey=host%3Amacbook&limit=500`,
    ]);
    expect(tables[0]).toEqual([
      {
        metric: "system.memory.usage",
        type: "gauge",
        unit: "percent",
        series: 1,
        lastSeenAt: "2026-07-07T12:00:00.000Z",
      },
    ]);
  });

  test("filters states by resource through bounded resource endpoints", async () => {
    const { ctx, calls, tables } = createContext(["states", baseId], { resource: "MacBook" }, [
      jsonResponse(base),
      jsonResponse(inventory.resources),
      jsonResponse(inventory.states),
    ]);

    await pulseCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/pulse/bases/${baseId}`,
      `/api/pulse/bases/${baseId}/resources?ref=MacBook&limit=20`,
      `/api/pulse/bases/${baseId}/resource-states?resourceKey=host%3Amacbook`,
    ]);
    expect(tables[0]).toEqual([
      {
        key: "system.host.online",
        value: "true",
        source: "Src001",
        entity: "host:macbook",
        entityType: "host",
        updatedAt: "2026-07-07T12:00:00.000Z",
      },
    ]);
  });

  test("filters series by resource through bounded resource endpoints", async () => {
    const { ctx, calls, tables } = createContext(["series", baseId, "system.memory.usage"], { resource: "MacBook" }, [
      jsonResponse(base),
      jsonResponse(inventory.resources),
      jsonResponse(inventory.metrics),
    ]);

    await pulseCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/pulse/bases/${baseId}`,
      `/api/pulse/bases/${baseId}/resources?ref=MacBook&limit=20`,
      `/api/pulse/bases/${baseId}/resource-metrics?resourceKey=host%3Amacbook&q=system.memory.usage&limit=500`,
    ]);
    expect(tables[0]).toEqual([
      {
        id: "33333333",
        metric: "system.memory.usage",
        type: "gauge",
        unit: "percent",
        source: "Src001",
        resource: "host:macbook",
        value: "61.2",
        lastSeenAt: "2026-07-07T12:00:00.000Z",
      },
    ]);
  });

  test("keeps resources JSON compact without signal payloads", async () => {
    const { ctx, lines } = createContext(
      ["resources", "list", baseId],
      {},
      [jsonResponse(base), jsonResponse(inventory.resources)],
      "json",
    );

    await pulseCli.run(ctx);

    const payload = JSON.parse(lines[0]!);
    expect(payload.resources).toEqual([
      {
        key: "host:macbook",
        id: "macbook",
        label: "MacBook",
        type: "host",
        sourceIds: [sourceId],
        metricSeriesCount: 1,
        metricCount: 1,
        eventCount: 0,
        stateCount: 1,
        lastSeenAt: "2026-07-07T12:00:00.000Z",
        dimensions: { host: "macbook" },
      },
    ]);
    expect(payload.metrics).toBeUndefined();
    expect(payload.states).toBeUndefined();
    expect(payload.events).toBeUndefined();
  });

  test("prints resources as compact table rows", async () => {
    const { ctx, calls, tables } = createContext(["resources", "list", baseId], { limit: "50", offset: "100" }, [
      jsonResponse(base),
      jsonResponse(inventory.resources),
    ]);

    await pulseCli.run(ctx);

    expect(calls.at(-1)?.path).toBe(`/api/pulse/bases/${baseId}/resources?limit=50&offset=100`);

    expect(tables[0]).toEqual([
      {
        key: "host:macbook",
        type: "host",
        label: "MacBook",
        metrics: 1,
        states: 1,
        events: 0,
        sources: 1,
        lastSeenAt: "2026-07-07T12:00:00.000Z",
      },
    ]);
  });

  test("does not match resource labels as state identities", async () => {
    const { ctx, tables } = createContext(["resources", "states", baseId, "MacBook"], {}, [
      jsonResponse(base),
      jsonResponse(inventory.resources),
      jsonResponse(inventory.states),
    ]);

    await pulseCli.run(ctx);

    expect(tables[0]).toEqual([
      {
        key: "system.host.online",
        value: "true",
        source: "Src001",
        entity: "host:macbook",
        entityType: "host",
        updatedAt: "2026-07-07T12:00:00.000Z",
      },
    ]);
  });

  test("streams list results as JSONL without rendering a table", async () => {
    const { ctx, lines, tables } = createContext(["list"], {}, [jsonResponse([base])], "jsonl");

    await pulseCli.run(ctx);

    expect(lines).toEqual([JSON.stringify(base)]);
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

  test("creates dashboards from DSL without sending compiled layout", async () => {
    const dsl = 'dashboard "Ops" {}';
    const dashboard = {
      id: dashboardId,
      baseId,
      name: "Ops",
      config: { dsl, layout: null, refreshIntervalSeconds: 5 },
      publicEnabled: false,
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
    };
    const { ctx, calls, lines } = createContext(["dashboards", "create", baseId], { name: "Ops", content: dsl }, [
      jsonResponse(base),
      jsonResponse({ ok: true, diagnostics: [], config: dashboard.config }),
      jsonResponse(dashboard, 201),
    ]);

    await pulseCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/pulse/bases/${baseId}`,
      "/api/pulse/dashboard-dsl/compile",
      `/api/pulse/bases/${baseId}/dashboards`,
    ]);
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
      name: "Ops",
      config: { dsl, refreshIntervalSeconds: 5 },
    });
    expect(lines).toEqual([`Created dashboard Ops (${dashboardId}).`]);
  });

  test("renders an authenticated dashboard snapshot without publishing it", async () => {
    const dashboard = {
      id: dashboardId,
      baseId,
      name: "Ops",
      config: { dsl: 'dashboard "Ops" {}', layout: null, refreshIntervalSeconds: 5 },
      publicEnabled: false,
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
    };
    const snapshot = {
      dashboard: { id: dashboardId, name: "Ops", config: { layout: null, refreshIntervalSeconds: 5 } },
      points: { cpu: [{ ts: "2026-07-07T12:00:00.000Z", value: 42 }] },
      events: { deploys: [{ id: "event", kind: "deploy", ts: "2026-07-07T12:00:00.000Z", value: {} }] },
      states: { health: [{ key: "service.online", value: true, updatedAt: "2026-07-07T12:00:00.000Z" }] },
    };
    const { ctx, calls, lines } = createContext(["dashboards", "snapshot", baseId, "Ops"], {}, [
      jsonResponse(base),
      jsonResponse([dashboard]),
      jsonResponse(snapshot),
    ]);

    await pulseCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/pulse/bases/${baseId}`,
      `/api/pulse/bases/${baseId}/dashboards`,
      `/api/pulse/dashboards/${dashboardId}/snapshot`,
    ]);
    expect(lines).toEqual(["Ops: 1 points, 1 events, 1 states"]);
  });

  test("updates dashboard DSL without sending compiled layout", async () => {
    const dsl = 'dashboard "Ops" {}';
    const dashboard = {
      id: dashboardId,
      baseId,
      name: "Ops",
      config: { dsl, layout: null, refreshIntervalSeconds: null },
      publicEnabled: false,
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
    };
    const { ctx, calls, lines } = createContext(["dashboards", "update", baseId, "Ops"], { content: dsl }, [
      jsonResponse(base),
      jsonResponse([dashboard]),
      jsonResponse({ ok: true, diagnostics: [], config: { dsl, layout: null } }),
      jsonResponse(dashboard),
    ]);

    await pulseCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/pulse/bases/${baseId}`,
      `/api/pulse/bases/${baseId}/dashboards`,
      "/api/pulse/dashboard-dsl/compile",
      `/api/pulse/dashboards/${dashboardId}`,
    ]);
    expect(JSON.parse(String(calls[3]?.init?.body))).toEqual({
      config: { dsl, refreshIntervalSeconds: null },
    });
    expect(lines).toEqual([`Updated dashboard Ops (${dashboardId}).`]);
  });

  test("preserves dashboard refresh while replacing DSL and supports explicit refresh updates", async () => {
    const previousDsl = 'dashboard "Ops" {}';
    const nextDsl = 'dashboard "Operations" {}';
    const dashboard = {
      id: dashboardId,
      baseId,
      name: "Ops",
      config: { dsl: previousDsl, layout: null, refreshIntervalSeconds: 60 },
      publicEnabled: false,
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
    };
    const { ctx, calls } = createContext(["dashboards", "update", baseId, "Ops"], { content: nextDsl }, [
      jsonResponse(base),
      jsonResponse([dashboard]),
      jsonResponse({ ok: true, diagnostics: [], config: { dsl: nextDsl, layout: null } }),
      jsonResponse({ ...dashboard, config: { ...dashboard.config, dsl: nextDsl } }),
    ]);

    await pulseCli.run(ctx);

    expect(JSON.parse(String(calls[3]?.init?.body))).toEqual({
      config: { dsl: nextDsl, refreshIntervalSeconds: 60 },
    });

    const { ctx: refreshCtx, calls: refreshCalls } = createContext(["dashboards", "update", baseId, "Ops"], { refresh: "never" }, [
      jsonResponse(base),
      jsonResponse([dashboard]),
      jsonResponse({ ...dashboard, config: { ...dashboard.config, refreshIntervalSeconds: null } }),
    ]);

    await pulseCli.run(refreshCtx);

    expect(JSON.parse(String(refreshCalls[2]?.init?.body))).toEqual({
      config: { dsl: previousDsl, refreshIntervalSeconds: null },
    });
  });

  test("prints a stable public display URL", async () => {
    const dashboard = {
      id: dashboardId,
      baseId,
      name: "Ops",
      config: { dsl: 'dashboard "Ops" {}', layout: null, refreshIntervalSeconds: 5 },
      publicEnabled: true,
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
    };
    const { ctx, calls, lines } = createContext(["dashboards", "public-url", baseId, "Ops"], { theme: "dark", height: "full", yes: true }, [
      jsonResponse(base),
      jsonResponse([dashboard]),
      jsonResponse({ dashboard, token: "public-token" }),
    ]);

    await pulseCli.run(ctx);

    expect(calls.at(-1)?.path).toBe(`/api/pulse/dashboards/${dashboardId}/public-token`);
    expect(calls.at(-1)?.init?.method).toBe("POST");
    expect(lines).toEqual(["http://cloud.test/app/pulse/display/public-token?theme=dark&height=full"]);
  });

  test("requires confirmation before creating or showing a public display URL", async () => {
    const { ctx } = createContext(["dashboards", "public-url", baseId, "Ops"]);

    await expect(pulseCli.run(ctx)).rejects.toThrow("Refusing to enable or show a public link without --yes.");
  });

  test("requires confirmation for every public-enabling dashboard command", async () => {
    const dsl = 'dashboard "Ops" {}';
    const { ctx: create } = createContext(["dashboards", "create", baseId], { name: "Ops", content: dsl, public: true });
    await expect(pulseCli.run(create)).rejects.toThrow("Refusing to create a public link without --yes.");

    const { ctx: publish } = createContext(["dashboards", "publish", baseId, "Ops"]);
    await expect(pulseCli.run(publish)).rejects.toThrow("Refusing to publish without --yes.");
  });

  test("keeps overview JSON compact unless inventory is requested", async () => {
    const { ctx, lines } = createContext(
      ["overview", baseId],
      {},
      [jsonResponse(base), jsonResponse([source]), jsonResponse(inventory), jsonResponse([]), jsonResponse([])],
      "json",
    );

    await pulseCli.run(ctx);

    const payload = JSON.parse(lines[0]!);
    expect(payload.inventory).toBeUndefined();
    expect(payload.summary).toEqual({
      base: "Test",
      sources: 1,
      resources: 1,
      resourceTypes: 1,
      metrics: 0,
      metricSeries: 1,
      events: 0,
      states: 1,
      fields: 1,
    });
    expect(payload.topResources).toHaveLength(1);
  });
});
