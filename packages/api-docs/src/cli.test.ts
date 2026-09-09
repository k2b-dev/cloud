import { describe, expect, test } from "bun:test";
import type { CloudCliContext } from "@k2b/cloud/cli";
import cli, { fetchOpenApiText, loadOperationsFromSources } from "./cli";
import { extractOperations, parseOpenApiDocument } from "./openapi";
import type { ApiDocSource } from "./sources";

const source: ApiDocSource = {
  id: "grids",
  name: "Grids",
  description: "Structured data.",
  url: "/api/grids/openapi.json",
};

const spec = {
  openapi: "3.1.0",
  servers: [{ url: "/api/grids" }],
  paths: {
    "/items": {
      post: {
        operationId: "createItem",
        summary: "Create an item",
        tags: ["Items"],
        responses: { 201: { description: "Created" } },
      },
    },
  },
};

const mockContext = (options: { args?: string[]; flags?: CloudCliContext["flags"]; fetch?: CloudCliContext["fetch"] } = {}) => {
  const output: string[] = [];
  const json: unknown[] = [];
  const tables: unknown[][] = [];
  const ctx = {
    args: options.args ?? [],
    flags: options.flags ?? {},
    options: { profile: "local", server: "https://cloud.example.com", token: "secret", output: "text" as const },
    getDefault: async () => undefined,
    setDefault: async () => {},
    createApiClient: () => ({}),
    fetch:
      options.fetch ??
      (async (path) => (String(path) === "/api/api-docs/sources" ? Response.json({ items: [source] }) : Response.json(spec))),
    readJson: async <T>(response: Response) => (await response.json()) as T,
    print: (value = "") => output.push(value),
    write: (value: string) => output.push(value),
    error: (value: string) => output.push(value),
    json: (value: unknown) => json.push(value),
    jsonLine: (value: unknown) => json.push(value),
    table: (rows: unknown[]) => tables.push(rows),
  } as unknown as CloudCliContext;
  return { ctx, output, json, tables };
};

describe("API Docs source fetching", () => {
  test("uses authenticated Cloud fetch for same-origin sources", async () => {
    const paths: string[] = [];
    const { ctx } = mockContext({
      fetch: async (path) => {
        paths.push(String(path));
        return Response.json(spec);
      },
    });
    await fetchOpenApiText(ctx, source, async () => {
      throw new Error("external fetch must not run");
    });
    expect(paths).toEqual(["/api/grids/openapi.json"]);
  });

  test("never forwards the Cloud bearer token to external sources", async () => {
    const externalSource = { ...source, url: "https://docs.example.org/grids.json" };
    let externalHeaders: Headers | undefined;
    const { ctx } = mockContext({
      fetch: async () => {
        throw new Error("Cloud fetch must not run");
      },
    });
    await fetchOpenApiText(ctx, externalSource, async (_url, init) => {
      externalHeaders = new Headers(init?.headers);
      return Response.json(spec);
    });
    expect(externalHeaders?.get("authorization")).toBeNull();
    expect(externalHeaders?.get("accept")).toBe("application/json");
  });
});

describe("API Docs CLI", () => {
  test("shows a compact operation from an effective path", async () => {
    const { ctx, output } = mockContext({ args: ["show", "grids", "POST", "/api/grids/items"] });
    expect(await cli.run(ctx)).toBeUndefined();
    expect(output.join("\n")).toContain("POST /api/grids/items");
    expect(output.join("\n")).toContain("Security: not declared");
  });

  test("keeps successful sources when another source fails", async () => {
    const broken = { ...source, id: "broken", name: "Broken" };
    const loaded = await loadOperationsFromSources([source, broken], async (item) => {
      if (item.id === "broken") throw new Error("503 unavailable");
      return extractOperations(item, parseOpenApiDocument(spec));
    });
    expect(loaded.operations.map((operation) => operation.operationId)).toEqual(["createItem"]);
    expect(loaded.errors).toEqual([{ app: "broken", error: "503 unavailable" }]);
  });
});
