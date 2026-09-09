import { describe, expect, test } from "bun:test";
import type { CloudCliContext } from "@k2b/cloud/cli";
import type { CustomAppDefinition } from "../custom-apps/contracts";
import { type CliCustomApp, customAppCommands } from "./custom-apps";
import { gqlCommands } from "./views-gql";

const baseId = "base1A";
const appId = "req001";
const tableId = "table1";
const base = { id: baseId, name: "Requests" };
const basePage = { items: [base], total: 1, limit: 500, offset: 0 };
const definition: CustomAppDefinition = {
  schemaVersion: 5,
  kind: "grids.custom-app",
  id: appId,
  baseId,
  name: "Request portal",
  startPageId: "home",
  pages: [
    {
      id: "home",
      title: "Requests",
      navigation: { visible: true },
      parameters: {},
      rows: [
        {
          id: "content",
          columns: [{ id: "main", span: 12, blocks: [{ id: "intro", type: "markdown", markdown: "Welcome" }] }],
        },
      ],
    },
    {
      id: "detail",
      title: "Request detail",
      navigation: { visible: false },
      parameters: { request_id: { type: "record", tableId, required: true } },
      rows: [
        {
          id: "detail-content",
          columns: [{ id: "detail-main", span: 12, blocks: [{ id: "detail-intro", type: "markdown", markdown: "Detail" }] }],
        },
      ],
    },
  ],
};
const app: CliCustomApp = {
  id: appId,
  baseId,
  name: "Request portal",
  icon: null,
  draftDefinition: definition,
  draftDiagnostics: [],
  draftCapabilities: null,
  publishedDefinition: definition,
  publishedDiagnostics: [],
  publishedCapabilities: null,
  publishedAt: "2026-08-11T12:00:00.000Z",
  createdAt: "2026-08-11T11:00:00.000Z",
  updatedAt: "2026-08-11T12:00:00.000Z",
  draftValid: true,
  publishedValid: true,
  hasUnpublishedChanges: false,
};
const publicApp = app;

type FetchCall = { path: string; init?: RequestInit };

const createContext = (responses: Response[], output: "text" | "json" = "json") => {
  const calls: FetchCall[] = [];
  const lines: string[] = [];
  const values: unknown[] = [];
  const ctx: CloudCliContext = {
    args: [],
    flags: {},
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
      const value = JSON.parse(await response.text());
      if (!response.ok) throw new Error(response.statusText);
      return value;
    },
    print: (line) => {
      if (line !== undefined) lines.push(line);
    },
    write: async () => undefined,
    error: () => undefined,
    json: (value) => values.push(value),
    jsonLine: (value) => values.push(value),
    table: () => undefined,
  };
  return { calls, ctx, lines, values };
};

const command = (path: string) => {
  const item = customAppCommands.find((candidate) => candidate.path.join(" ") === path);
  if (!item) throw new Error(`${path} command is missing`);
  return item;
};

const gqlCommand = (path: string) => {
  const item = gqlCommands.find((candidate) => candidate.path.join(" ") === path);
  if (!item) throw new Error(`${path} command is missing`);
  return item;
};

describe("Grids Apps CLI", () => {
  test("exposes one deterministic lifecycle without granular page or block commands", () => {
    expect(customAppCommands.map((item) => item.path.join(" "))).toEqual([
      "apps reference",
      "apps list",
      "apps create",
      "apps get",
      "apps validate",
      "apps plan",
      "apps apply",
      "apps export",
      "apps publish",
      "apps unpublish",
      "apps restore",
      "apps delete",
    ]);
  });

  test("requires explicit sources and confirmation for live or destructive changes", () => {
    for (const path of ["apps validate", "apps plan", "apps apply"]) {
      expect(command(path).flags?.source).toMatchObject({ kind: "input", required: true, fileName: "source-file", stdinName: "stdin" });
    }
    expect(command("apps create").flags?.name).toMatchObject({ kind: "string", required: true });
    expect(command("apps apply").flags?.dryRun).toMatchObject({ kind: "boolean", name: "dry-run" });
    for (const path of ["apps publish", "apps unpublish", "apps restore", "apps delete"]) {
      expect(command(path).flags?.yes).toMatchObject({ kind: "boolean", name: "yes" });
    }
  });

  test("routes apply --dry-run through the plan endpoint without applying", async () => {
    const planned = { valid: true, diagnostics: [], action: "noop", changes: [] };
    const { calls, ctx, values } = createContext([Response.json(basePage), Response.json(planned)]);

    await command("apps apply").run({
      ctx,
      args: { args: [baseId] },
      flags: {
        base: undefined,
        source: { source: "value", value: Bun.YAML.stringify(definition), provided: true },
        dryRun: true,
      },
    });

    expect(calls.map((call) => call.path)).toEqual([`/api/grids/bases?q=${baseId}&limit=500&offset=0`, "/api/grids/apps/plan"]);
    expect(calls[1]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ definition });
    expect(values).toEqual([planned]);
  });

  test("creates the same blank draft as the visual New App action", async () => {
    const { calls, ctx, values } = createContext([Response.json(basePage), Response.json(app, { status: 201 })]);

    await command("apps create").run({
      ctx,
      args: { args: [baseId] },
      flags: { base: undefined, name: app.name },
    });

    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/apps/by-base/${baseId}`,
    ]);
    expect(calls[1]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ name: app.name });
    expect(values).toEqual([publicApp]);
  });

  test("restores the live definition as the draft", async () => {
    const { calls, ctx, values } = createContext([Response.json(basePage), Response.json([app]), Response.json(app)]);

    await command("apps restore").run({
      ctx,
      args: { args: [baseId, app.name] },
      flags: { base: undefined, app: undefined, yes: true },
    });

    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/apps/by-base/${baseId}`,
      `/api/grids/apps/${appId}/restore`,
    ]);
    expect(calls[2]?.init?.method).toBe("POST");
    expect(values).toEqual([publicApp]);
  });

  test("exports the exact live definition without reading the draft endpoint", async () => {
    const { calls, ctx, values } = createContext([Response.json(basePage), Response.json([app])]);

    await command("apps export").run({
      ctx,
      args: { args: [baseId, app.name] },
      flags: { base: undefined, app: undefined, published: true, out: undefined },
    });

    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/apps/by-base/${baseId}`,
    ]);
    expect(values).toEqual([definition]);
  });

  test("reports draft, live, change, URL, and diagnostic state", async () => {
    const attention = {
      ...app,
      draftValid: false,
      hasUnpublishedChanges: true,
      draftDiagnostics: [{ path: ["pages", 0], message: "Page needs content" }],
    };
    const { ctx, lines } = createContext([Response.json(basePage), Response.json([attention])], "text");

    await command("apps get").run({
      ctx,
      args: { args: [baseId, app.name] },
      flags: { base: undefined, app: undefined },
    });

    expect(lines).toContain("state: needs-attention");
    expect(lines).toContain("draft: needs attention");
    expect(lines).toContain(`live: ${app.publishedAt}`);
    expect(lines).toContain("unpublished changes: yes");
    expect(lines).toContain(`url: /apps/${appId}`);
    expect(lines).toContain("draft pages.0: Page needs content");
  });

  test("adds only the selected App page context to GQL autocomplete", async () => {
    const autocomplete = { ok: true as const, diagnostics: [], items: [] };
    const { calls, ctx, values } = createContext([Response.json(basePage), Response.json([app]), Response.json(autocomplete)]);

    await gqlCommand("gql autocomplete").run({
      ctx,
      args: { args: [baseId] },
      flags: {
        base: undefined,
        table: undefined,
        view: undefined,
        app: app.name,
        page: "detail",
        query: { source: "value", value: "where @", provided: true },
        caret: 7,
      },
    });

    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/apps/by-base/${baseId}`,
      `/api/grids/gql/by-base/${baseId}/autocomplete`,
    ]);
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
      query: "where @",
      caret: 7,
      contextKeys: [
        "auth.id",
        "auth.name",
        "auth.username",
        "auth.email",
        "auth.subjects",
        "page.id",
        "page.title",
        "page.url",
        "app.id",
        "app.name",
        "base.id",
        "base.name",
        "time.now",
        "time.today",
        "time.timeZone",
        "params.request_id",
      ],
    });
    expect(values).toEqual([autocomplete]);
  });
});
