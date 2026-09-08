import { describe, expect, test } from "bun:test";
import { defineCliCommands } from "../commands";
import type { CloudCliContext, CloudCliFlags } from "../index";
import { natsCommands } from "./nats";

const module = defineCliCommands({ name: "admin", summary: "NATS", commands: natsCommands });
const snapshot = {
  sampledAt: "2026-09-08T12:00:00Z",
  cluster: { status: "available", nodes: [{ name: "n1" }] },
  inventory: {
    status: "partial",
    issue: "incomplete",
    streams: [{ name: "stream1" }],
    consumers: [{ name: "worker", pending: 12 }],
    matchedTotal: null,
    total: 1,
    nextOffset: 50,
  },
};
const invoke = async (args: string[], flags: CloudCliFlags = {}, output: "json" | "jsonl" = "json") => {
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
      return Response.json(snapshot);
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
describe("NATS CLI", () => {
  test("forwards combined filters and preserves partial and paging metadata in JSON", async () => {
    const result = await invoke(["nats", "streams", "list"], {
      app: "mail",
      namespace: "dev",
      resource: "mail:job",
      problems: true,
      offset: "50",
      limit: "20",
    });
    const query = new URL(result.paths[0]!, "http://test").searchParams;
    expect(Object.fromEntries(query)).toEqual({
      app: "mail",
      namespace: "dev",
      resource: "mail:job",
      problems: "true",
      offset: "50",
      limit: "20",
    });
    expect(JSON.parse(result.lines[0]!)).toEqual(snapshot);
  });
  test("JSONL retains metadata separately and emits full selected records", async () => {
    const result = await invoke(["nats", "consumers", "list", "my-stream"], { offset: "3" }, "jsonl");
    expect(result.paths[0]).toBe("/api/gateway/nats?stream=my-stream&consumerOffset=3");
    const lines = result.lines.map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ type: "snapshot", inventory: { status: "partial", matchedTotal: null, nextOffset: 50 } });
    expect(lines[0].inventory.streams).toBeUndefined();
    expect(lines[1]).toEqual({ type: "consumers", name: "worker", pending: 12 });
  });
  test("status reads the same diagnostic API and validates paging and stream selectors", async () => {
    expect((await invoke(["nats", "status"])).paths).toEqual(["/api/gateway/nats"]);
    await expect(invoke(["nats", "streams", "list"], { limit: "101" })).rejects.toThrow();
    await expect(invoke(["nats", "consumers", "list", "bad.*"])).rejects.toThrow("Invalid NATS stream");
  });
});
