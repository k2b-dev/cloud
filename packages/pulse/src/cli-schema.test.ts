import { describe, expect, test } from "bun:test";
import type { CloudCliContext, CloudCliFlags, CloudCliOutputMode } from "@k2b/cloud/cli";
import pulseCli from "./cli";
import type { BaseSchemaRead } from "./schema-contracts";

const baseId = "Base01";
const base = { id: baseId, name: "Test" };

const createContext = (args: string[], flags: CloudCliFlags = {}, responses: Response[] = [], output: CloudCliOutputMode = "text") => {
  const calls: string[] = [];
  const lines: string[] = [];
  const errors: string[] = [];
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
    fetch: async (path) => {
      calls.push(path);
      const response = responses.shift();
      if (!response) throw new Error(`Unexpected fetch: ${path}`);
      return response;
    },
    readJson: async (response) => {
      const value = await response.json();
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return value;
    },
    print: (value = "") => lines.push(value),
    write: async (value) => void lines.push(value),
    error: (value) => errors.push(value),
    json: (value) => lines.push(JSON.stringify(value)),
    jsonLine: (value) => lines.push(JSON.stringify(value)),
    table: (rows) => tables.push(rows),
  };
  return { ctx, calls, lines, errors, tables };
};

const schema: BaseSchemaRead = {
  baseId,
  generatedAt: "2026-10-20T10:00:00.000Z",
  kind: "order.created",
  truncated: false,
  metrics: { total: 0, items: [] },
  states: { total: 0, items: [] },
  events: {
    total: 1,
    items: [
      {
        kind: "order.created",
        firstSeenAt: "2026-10-01T10:00:00.000Z",
        lastSeenAt: "2026-10-20T10:00:00.000Z",
        sampledRows: 4,
        fieldsTruncated: false,
        fields: [{ key: "amount", type: "number", types: ["number"], present: 3, fillRate: 0.75 }],
        samples: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            ts: "2026-10-20T10:00:00.000Z",
            value: null,
            sourceId: "Src001",
            actorId: "",
            sessionId: "",
            correlationId: "",
            resourceKey: "",
            dimensions: null,
            attributes: { amount: 12.5 },
            attributesTruncated: false,
          },
        ],
      },
    ],
  },
};

describe("Pulse schema CLI", () => {
  test("reads one kind through the base schema endpoint and prints fields and entries", async () => {
    const context = createContext(["schema", baseId], { kind: "order.created" }, [Response.json(base), Response.json(schema)]);
    expect(await pulseCli.run(context.ctx)).toBe(0);
    expect(context.calls).toEqual([`/api/pulse/bases/${baseId}`, `/api/pulse/bases/${baseId}/schema?kind=order.created`]);
    expect(context.tables).toEqual([
      [{ kind: "order.created", sampled: 4, fields: "amount:number 75%", lastSeenAt: schema.events.items[0]!.lastSeenAt }],
    ]);
    expect(context.lines.join("\n")).toContain('"amount":12.5');
    expect(context.errors).toEqual([]);
  });

  test("prints the validated result as JSON", async () => {
    const context = createContext(["schema"], { base: baseId }, [Response.json(base), Response.json(schema)], "json");
    expect(await pulseCli.run(context.ctx)).toBe(0);
    expect(context.calls[1]).toBe(`/api/pulse/bases/${baseId}/schema`);
    expect(JSON.parse(context.lines[0]!)).toEqual(schema);
  });

  test("says when the result was shortened", async () => {
    const context = createContext(["schema", baseId], {}, [Response.json(base), Response.json({ ...schema, kind: null, truncated: true })]);
    expect(await pulseCli.run(context.ctx)).toBe(0);
    expect(context.errors).toEqual(["The result was shortened to its limits. Pass --kind to read one kind."]);
  });

  test.each([
    ["BAD_INPUT", 2],
    ["TIME_LIMIT", 4],
    ["BUSY", 5],
    ["QUOTA", 5],
    ["NO_READ_ACCESS", 6],
    ["STORE_UNAVAILABLE", 7],
  ] as const)("maps %s to exit %s", async (code, expected) => {
    const context = createContext(["schema", baseId], {}, [
      Response.json(base),
      Response.json({ code, message: "Read refused." }, { status: 503 }),
    ]);
    expect(await pulseCli.run(context.ctx)).toBe(expected);
    expect(context.errors).toEqual([`${code}: Read refused.`]);
  });

  test("unknown failures and unreadable answers never print the remote body", async () => {
    const remote = createContext(["schema", baseId], {}, [
      Response.json(base),
      Response.json({ code: "REMOTE", message: "SECRET_MUST_NOT_PRINT" }, { status: 500 }),
    ]);
    expect(await pulseCli.run(remote.ctx)).toBe(7);
    expect(remote.errors).toEqual(["REMOTE: The Pulse schema request failed."]);

    const garbled = createContext(["schema", baseId], {}, [Response.json(base), Response.json({ secret: "SECRET_MUST_NOT_PRINT" })]);
    expect(await pulseCli.run(garbled.ctx)).toBe(7);
    expect([...garbled.lines, ...garbled.errors].join()).not.toContain("SECRET_MUST_NOT_PRINT");
  });
});
