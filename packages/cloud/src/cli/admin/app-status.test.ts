import { expect, test } from "bun:test";
import { defineCliCommands } from "../commands";
import type { CloudCliContext, CloudCliFlags } from "../index";
import { appStatusCommands } from "./app-status";

const module = defineCliCommands({ name: "admin", summary: "Application migration", commands: appStatusCommands });
const invoke = async (args: string[], flags: CloudCliFlags, result: unknown, outputMode: "text" | "json" = "json") => {
  const output: unknown[] = [],
    requests: { path: string; body: unknown }[] = [];
  const ctx: CloudCliContext = {
    args: ["apps", ...args],
    flags,
    options: { profile: "test", server: "https://test.example", token: "test", output: outputMode },
    getDefault: async () => undefined,
    setDefault: async () => {},
    createApiClient: () => {
      throw new Error("Unused");
    },
    fetch: async (path, init) => {
      requests.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      return Response.json(result);
    },
    readJson: async (response) => response.json(),
    print: (value) => output.push(value),
    write: async () => {},
    error: () => {},
    json: (value) => output.push(value),
    jsonLine: (value) => output.push(value),
    table: (rows) => output.push(rows),
  };
  const code = await module.run(ctx);
  return { code, output, requests };
};
test("status preserves machine JSON, explicit inventory and exceptions, and never exits zero for incomplete data", async () => {
  for (const needsAttention of [true, false]) {
    const result = {
      needsAttention,
      apps: [],
      registryIssues: [],
      observation: { startedAt: null, lastLegacyUseAt: null, observedAt: "2030-01-02T00:00:00.000Z", windowSeconds: null, complete: false },
    };
    expect(await invoke(["status"], { strict: true, expect: "mail,inventory", "allow-env": "inventory" }, result)).toEqual({
      code: needsAttention ? 1 : 0,
      output: [result],
      requests: [{ path: "/api/admin/apps/status?expect=mail%2Cinventory&allowEnv=inventory", body: null }],
    });
    expect((await invoke(["status"], {}, result)).code).toBe(needsAttention ? 1 : 0);
  }
  await expect(invoke(["status"], { expect: "core" }, {})).rejects.toThrow("Core and Gateway");
  await expect(invoke(["status"], { "allow-env": "../wrong" }, {})).rejects.toThrow("App ID");
  await expect(invoke(["status"], {}, { apps: [] })).rejects.toThrow();
});

test("status includes rejected starts and attention reasons in text and machine JSON", async () => {
  const lastRejectedStart = { at: "2030-01-02T00:00:00.000Z", reason: "revoked", keyId: null };
  const result = {
    needsAttention: true,
    registryIssues: [],
    observation: { startedAt: null, lastLegacyUseAt: null, observedAt: "2030-01-02T00:00:00.000Z", windowSeconds: 86400, complete: false },
    apps: [
      {
        appId: "mail",
        status: "stopped",
        expectedBy: ["expect"],
        allowedEnv: false,
        needsAttention: true,
        attentionReasons: ["last_rejected_start"],
        lastRejectedStart,
        instances: [],
        probes: [],
      },
    ],
  };
  const json = await invoke(["status"], { "observation-seconds": "86400" }, result);
  expect(json.output).toEqual([result]);
  expect(json.requests[0]?.path).toContain("windowSeconds=86400");
  const text = await invoke(["status"], {}, result, "text");
  expect(text.code).toBe(1);
  expect(text.output).toContain("mail: last_rejected_start");
  expect(text.output).toContain("mail: lastRejectedStart 2030-01-02T00:00:00.000Z · revoked · key unknown");
});
test("observation begins through the administrator write endpoint", async () => {
  const result = { startedAt: "2030-01-02T00:00:00.000Z" };
  expect((await invoke(["observation", "begin"], {}, result)).requests).toEqual([{ path: "/api/admin/apps/observation", body: {} }]);
});
