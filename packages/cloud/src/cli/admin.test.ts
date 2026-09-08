import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import adminCli from "./admin";
import type { CloudCliContext, CloudCliFlags, CloudCliTableColumn } from "./index";

type FetchCall = {
  path: string;
  init?: RequestInit;
};

const jsonResponse = (value: unknown, status = 200) => Response.json(value, { status });

const textResponse = (value: string, status = 200) => new Response(value, { status });

const createContext = (args: string[], flags: CloudCliFlags = {}, responses: Response[] = []) => {
  const calls: FetchCall[] = [];
  const lines: string[] = [];
  const tables: unknown[][] = [];
  const tableColumns: CloudCliTableColumn<Record<string, unknown>>[][] = [];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "http://cloud.test", token: "token", output: "text" },
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
      if (!response.ok) throw new Error(typeof value?.message === "string" ? value.message : response.statusText);
      return value;
    },
    print: (value = "") => lines.push(value),
    write: async (value) => void lines.push(value),
    error: (value) => lines.push(value),
    json: (value) => lines.push(JSON.stringify(value, null, 2)),
    jsonLine: (value) => lines.push(JSON.stringify(value)),
    table: (rows, columns) => {
      tables.push(rows);
      tableColumns.push(columns as CloudCliTableColumn<Record<string, unknown>>[]);
    },
  };
  return { ctx, calls, lines, tables, tableColumns };
};

describe("admin CLI", () => {
  const linuxConfig = { enabled: true, rangeStart: 200000, rangeEnd: 299999, homeTemplate: "/home/{username}", loginShell: "/bin/bash" };

  test("exports Linux configuration without preview metadata", async () => {
    const { ctx, calls, lines } = createContext(["linux", "config", "get"], {}, [
      jsonResponse({ config: linuxConfig, items: [], nextCursor: null }),
    ]);
    ctx.options.output = "json";
    await adminCli.run(ctx);
    expect(calls[0]?.path).toBe("/api/admin/core/linux-identities");
    expect(JSON.parse(lines[0]!)).toEqual(linuxConfig);
  });

  test("preserves Linux preview pagination in JSONL", async () => {
    const page = { config: linuxConfig, items: [], nextCursor: "next" };
    const { ctx, calls, lines } = createContext(["linux", "preview"], { after: "cursor" }, [jsonResponse(page)]);
    ctx.options.output = "jsonl";
    await adminCli.run(ctx);
    expect(calls[0]?.path).toBe("/api/admin/core/linux-identities?after=cursor");
    expect(lines).toEqual([JSON.stringify(page)]);
  });

  test("passes Linux username and eligibility filters to the server", async () => {
    const { ctx, calls } = createContext(["linux", "preview"], { search: "alice", scope: "ready", after: "cursor" }, [
      jsonResponse({ items: [], nextCursor: null }),
    ]);
    await adminCli.run(ctx);
    expect(calls[0]?.path).toBe("/api/admin/core/linux-identities?after=cursor&search=alice&scope=ready");
  });

  test("requires explicit Linux configuration and range confirmation before writes", async () => {
    const cases: CloudCliFlags[] = [{ config: JSON.stringify(linuxConfig) }, { config: JSON.stringify(linuxConfig), yes: true }];
    for (const flags of cases) {
      const { ctx, calls } = createContext(["linux", "config", "set"], flags);
      await expect(adminCli.run(ctx)).rejects.toThrow();
      expect(calls).toHaveLength(0);
    }
  });

  test("saves full Linux configuration through its dedicated endpoint", async () => {
    const { ctx, calls } = createContext(
      ["linux", "config", "set"],
      { config: JSON.stringify(linuxConfig), yes: true, "range-reserved": true },
      [jsonResponse(linuxConfig)],
    );
    await adminCli.run(ctx);
    expect(calls[0]?.path).toBe("/api/admin/core/linux-identities/configuration");
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ config: linuxConfig, rangeReserved: true });
  });

  test("rejects invalid Linux configuration without a request", async () => {
    const { ctx, calls } = createContext(["linux", "config", "set"], {
      config: JSON.stringify({ ...linuxConfig, loginShell: "relative" }),
      yes: true,
      "range-reserved": true,
    });
    await expect(adminCli.run(ctx)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test("reads Linux configuration from a file and rejects competing inputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cloud-linux-cli-"));
    const file = join(directory, "linux.json");
    try {
      await writeFile(file, JSON.stringify(linuxConfig));
      const { ctx, calls } = createContext(["linux", "config", "set"], { "config-file": file, yes: true, "range-reserved": true }, [
        jsonResponse(linuxConfig),
      ]);
      await adminCli.run(ctx);
      expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ config: linuxConfig, rangeReserved: true });
      const conflicting = createContext(["linux", "config", "set"], { config: "{}", "config-file": file, yes: true });
      await expect(adminCli.run(conflicting.ctx)).rejects.toThrow();
      expect(conflicting.calls).toHaveLength(0);
    } finally {
      await rm(file);
      await rm(directory, { recursive: true });
    }
  });

  test("can disable preparation without confirming an active range", async () => {
    const config = { ...linuxConfig, enabled: false };
    const { ctx, calls } = createContext(["linux", "config", "set"], { config: JSON.stringify(config), yes: true }, [jsonResponse(config)]);
    await adminCli.run(ctx);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ config, rangeReserved: false });
  });

  const legalDocuments = [
    { kind: "terms", path: "/legal/terms", mode: "local", content: "# Terms", url: "" },
    { kind: "privacy", path: "/legal/privacy", mode: "external", content: "", url: "https://example.org/privacy" },
    { kind: "imprint", path: "/impressum", mode: "local", content: "# Imprint", url: "" },
  ];

  test("lists the effective legal document sources", async () => {
    const { ctx, calls, tables } = createContext(["legal", "list"], {}, [jsonResponse({ items: legalDocuments })]);

    await adminCli.run(ctx);

    expect(calls[0]?.path).toBe("/api/admin/core/settings/legal");
    expect(tables[0]).toEqual([
      { document: "terms", source: "local", target: "/legal/terms" },
      { document: "privacy", source: "external", target: "https://example.org/privacy" },
      { document: "imprint", source: "local", target: "/impressum" },
    ]);
  });

  test("publishes legal Markdown through the atomic settings endpoint", async () => {
    const { ctx, calls, lines } = createContext(["legal", "set", "terms"], { content: "# Updated terms" }, [textResponse("", 204)]);

    await adminCli.run(ctx);

    expect(calls[0]?.path).toBe("/api/admin/core/settings");
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      updates: {
        "legal.terms.mode": "local",
        "legal.terms.content": "# Updated terms",
      },
    });
    expect(lines).toEqual(["Updated terms."]);
  });

  test("switches a legal document to an external URL", async () => {
    const { ctx, calls } = createContext(["legal", "set", "privacy"], { url: "https://example.org/privacy" }, [textResponse("", 204)]);

    await adminCli.run(ctx);

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      updates: {
        "legal.privacy.mode": "external",
        "legal.privacy.url": "https://example.org/privacy",
      },
    });
  });

  test("guards a complete legal document reset", async () => {
    const guarded = createContext(["legal", "reset", "privacy"]);
    await expect(adminCli.run(guarded.ctx)).rejects.toThrow("without --yes");
    expect(guarded.calls).toHaveLength(0);

    const confirmed = createContext(["legal", "reset", "privacy"], { yes: true }, [textResponse("", 204)]);
    await adminCli.run(confirmed.ctx);

    expect(JSON.parse(String(confirmed.calls[0]?.init?.body))).toEqual({
      resets: ["legal.privacy.mode", "legal.privacy.content", "legal.privacy.url"],
    });
  });

  test("lists gateway routes with filters", async () => {
    const { ctx, calls, tables, tableColumns } = createContext(
      ["routes", "list"],
      { q: "api", app: "contacts", errors: true, sort: "errors" },
      [
        jsonResponse({
          generatedAt: "2026-06-29T10:00:00.000Z",
          instanceId: "gw-1",
          total: 2,
          routeCount: 1,
          items: [
            {
              prefix: "/app/contacts",
              appId: "contacts",
              count: 12,
              errors: 1,
              slow: 2,
              avgDurationMs: 18.5,
            },
          ],
        }),
      ],
    );

    await adminCli.run(ctx);

    // The default traffic window is part of the request now; route counts are
    // windowed rather than cumulative since the router booted.
    expect(calls[0]?.path).toBe("/api/gateway/routes?search=api&app=contacts&errors=true&sort=errors&range=24h");
    expect(tables[0]).toEqual([
      {
        prefix: "/app/contacts",
        app: "contacts",
        requests: 12,
        errors: 1,
        slow: 2,
        avgMs: "19ms",
      },
    ]);
    expect(tableColumns[0]?.map((column) => column.key)).toEqual(["prefix", "app", "requests", "errors", "slow", "avgMs"]);
  });

  test("reads raw Prometheus metrics", async () => {
    const { ctx, calls, lines } = createContext(["metrics", "read"], {}, [textResponse("# HELP cloud_up\ncloud_up 1\n")]);

    await adminCli.run(ctx);

    expect(calls[0]?.path).toBe("/metrics");
    expect(lines).toEqual(["# HELP cloud_up\ncloud_up 1"]);
  });

  test("creates metrics tokens with normalized expiry", async () => {
    const { ctx, calls, lines } = createContext(["metrics", "tokens", "create", "grafana"], { "expires-at": "never" }, [
      jsonResponse({
        token: "cld_metric_secret",
        credential: {
          id: "tok_1",
          name: "grafana",
          tokenPrefix: "cld_metric",
          expiresAt: null,
          lastUsedAt: null,
          createdAt: "2026-06-29T10:00:00.000Z",
        },
      }),
    ]);

    await adminCli.run(ctx);

    expect(calls[0]?.path).toBe("/api/gateway/metrics/tokens");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ name: "grafana", expiresAt: null });
    expect(lines[0]).toContain("Token: cld_metric_secret");
  });

  test("pages workflow runs and drills into one parent", async () => {
    const { ctx, calls } = createContext(
      ["workflows", "runs"],
      {
        parent: "00000000-0000-4000-8000-000000000001",
        state: "failed",
        mode: "dryRun",
        children: true,
        window: "7d",
        page: "3",
        limit: "25",
      },
      [jsonResponse({ items: [] })],
    );

    await adminCli.run(ctx);

    expect(calls[0]?.path).toBe(
      "/api/gateway/workflows/runs?parent=00000000-0000-4000-8000-000000000001&state=failed&mode=dryRun&children=true&window=7d&page=3&per_page=25",
    );
  });

  test("pages workflow finding queues", async () => {
    const effects = createContext(["workflows", "effects"], { app: "mail", page: "2", limit: "40" }, [jsonResponse({ items: [] })]);
    const events = createContext(["workflows", "events"], { app: "grids", page: "4", limit: "75" }, [jsonResponse({ items: [] })]);

    await adminCli.run(effects.ctx);
    await adminCli.run(events.ctx);

    expect(effects.calls[0]?.path).toBe("/api/gateway/workflows/effects?app=mail&page=2&limit=40");
    expect(events.calls[0]?.path).toBe("/api/gateway/workflows/events?app=grids&page=4&limit=75");
  });

  test("requires confirmation before canceling a workflow run", async () => {
    const runId = "00000000-0000-4000-8000-000000000001";
    const unconfirmed = createContext(["workflows", "cancel", runId]);
    await expect(adminCli.run(unconfirmed.ctx)).rejects.toThrow("without --yes");
    expect(unconfirmed.calls).toHaveLength(0);

    const confirmed = createContext(["workflows", "cancel", runId], { yes: true }, [jsonResponse({ canceled: true })]);
    await adminCli.run(confirmed.ctx);

    expect(confirmed.calls[0]?.path).toBe(`/api/gateway/workflows/runs/${runId}/cancel`);
    expect(confirmed.calls[0]?.init?.method).toBe("POST");
    expect(confirmed.lines).toEqual([`Cancellation requested for ${runId}.`]);
  });
});
