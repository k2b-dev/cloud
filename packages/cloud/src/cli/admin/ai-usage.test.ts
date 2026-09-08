import { describe, expect, test } from "bun:test";
import { defineCliCommands } from "../commands";
import type { CloudCliContext, CloudCliFlags } from "../index";
import { aiUsageCommands } from "./ai-usage";
const module = defineCliCommands({ name: "admin", summary: "AI usage", commands: aiUsageCommands });
const invoke = async (args: string[], flags: CloudCliFlags, result: unknown, output: "json" | "jsonl" = "json") => {
  const paths: string[] = [];
  const lines: string[] = [];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "http://test", token: "test", output },
    getDefault: async () => undefined,
    setDefault: async () => undefined,
    createApiClient: () => {
      throw new Error("unused");
    },
    fetch: async (path) => {
      paths.push(path);
      return Response.json(result);
    },
    readJson: async (response) => response.json(),
    print: (value = "") => {
      lines.push(value);
    },
    write: async (value) => {
      lines.push(value);
    },
    error: (value) => {
      lines.push(value);
    },
    jsonLine: (value) => {
      lines.push(JSON.stringify(value));
    },
    json: (value) => {
      lines.push(JSON.stringify(value));
    },
    table: () => {},
  };
  await module.run(ctx);
  return { paths, lines };
};
describe("AI usage CLI", () => {
  test("forwards combined filters and preserves page metadata in JSON", async () => {
    const page = { items: [{ id: "a", negative: 9, rated: 10 }], page: 2, perPage: 1, total: 3 };
    const report = { users: page, query: { until: "2026-09-08T12:00:00Z" }, since: "start", until: "end" };
    const { paths, lines } = await invoke(
      ["ai", "usage", "users"],
      {
        user: "11111111-1111-4111-8111-111111111111",
        model: "fast",
        "provider-model": "provider/fast",
        sort: "negativeRate",
        page: "2",
        "per-page": "1",
      },
      report,
    );
    const q = new URL(paths[0]!, "http://test").searchParams;
    expect(q.get("userId")).toBe("11111111-1111-4111-8111-111111111111");
    expect(q.get("modelProfileId")).toBe("fast");
    expect(q.get("providerModel")).toBe("provider/fast");
    expect(q.get("page")).toBe("2");
    expect(q.get("sort")).toBe("negativeRate");
    expect(JSON.parse(lines[0]!)).toEqual({ ...page, query: report.query, since: "start", until: "end" });
  });
  test("streams each full error row in JSONL and reads a single record", async () => {
    const items = [
      { id: "1", error: "complete error" },
      { id: "2", error: "another error" },
    ];
    const { lines } = await invoke(
      ["ai", "usage", "runs"],
      { kind: "background", status: "failed" },
      { runs: { items, page: 1, perPage: 50, total: 2 } },
      "jsonl",
    );
    expect(lines.map((line) => JSON.parse(line))).toEqual(items);
    const result = await invoke(["ai", "usage", "get", "background", "11111111-1111-4111-8111-111111111111"], {}, items[0]);
    expect(result.paths[0]).toBe("/api/admin/core/ai-usage/runs/background/11111111-1111-4111-8111-111111111111");
  });
  test("discovers searchable identifiers and rejects invalid enum options", async () => {
    const result = await invoke(
      ["ai", "usage", "facets"],
      { field: "userId", search: "Ada" },
      { items: [{ id: "user-id", label: "Ada" }] },
    );
    expect(result.paths[0]).toContain("field=userId");
    expect(result.paths[0]).toContain("search=Ada");
    await expect(invoke(["ai", "usage", "runs"], { kind: "bogus" }, {})).rejects.toThrow();
  });
});
