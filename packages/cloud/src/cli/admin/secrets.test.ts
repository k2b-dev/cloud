import { expect, test } from "bun:test";
import { defineCliCommands } from "../commands";
import type { CloudCliContext, CloudCliFlags } from "../index";
import admin from "./index";
import { secretCommands } from "./secrets";

const module = defineCliCommands({ name: "admin", summary: "Secret rotation", commands: secretCommands });
const result = (ready: boolean) => ({
  checkedAt: "2030-01-02T00:02:00.000Z",
  current: "ABCDEFGHIJKLMNOP",
  lastRingChange: "2030-01-02T00:00:00.000Z",
  ready,
  registryIssues: [],
  apps: [],
});
const invoke = async (flags: CloudCliFlags, response: unknown, failure?: Error, fullModule = false) => {
  const output: unknown[] = [],
    errors: string[] = [],
    requests: string[] = [];
  const ctx: CloudCliContext = {
    args: ["secrets", "status"],
    flags,
    options: { profile: "test", server: "https://example.test", token: "test", output: "json" },
    getDefault: async () => undefined,
    setDefault: async () => {},
    createApiClient: () => {
      throw new Error("unused");
    },
    fetch: async (path) => {
      requests.push(path);
      if (failure) throw failure;
      return Response.json(response);
    },
    readJson: async (response) => response.json(),
    print: (value) => output.push(value),
    write: async () => {},
    error: (value) => errors.push(value),
    json: (value) => output.push(value),
    jsonLine: (value) => output.push(value),
    table: (rows) => output.push(rows),
  };
  return { code: await (fullModule ? admin : module).run(ctx), output, errors, requests };
};

test("strict preserves status JSON and exits 1 until readiness is complete", async () => {
  for (const ready of [false, true]) {
    const status = result(ready);
    expect(await invoke({ strict: true, expect: "mail,gateway" }, status)).toEqual({
      code: ready ? 0 : 1,
      output: [status],
      errors: [],
      requests: ["/api/admin/secrets/status?expect=mail%2Cgateway"],
    });
    expect((await invoke({}, status)).code).toBe(0);
  }
});

test("usage, schema, auth and transport errors exit 2 without reporting readiness", async () => {
  expect((await invoke({ expect: "../wrong" }, result(true))).code).toBe(2);
  expect((await invoke({}, { ready: true })).code).toBe(2);
  for (const message of ["403 Administrator access required", "transport unavailable"]) {
    const call = await invoke({ strict: true }, null, new Error(message));
    expect(call.code).toBe(2);
    expect(call.output).toEqual([]);
    expect(call.errors).toContain(message);
  }
  expect((await invoke({ unexpected: true }, result(true), undefined, true)).code).toBe(2);
});
