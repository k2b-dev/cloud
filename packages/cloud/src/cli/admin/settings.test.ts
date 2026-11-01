import { expect, test } from "bun:test";
import { defineCliCommands } from "../commands";
import type { CloudCliContext, CloudCliFlags } from "../index";
import { settingsCommands } from "./settings";

const module = defineCliCommands({ name: "admin", summary: "Settings", commands: settingsCommands });
const invoke = async (args: string[], flags: CloudCliFlags, result: unknown) => {
  const output: unknown[] = [],
    requests: { path: string; body: unknown }[] = [];
  const ctx: CloudCliContext = {
    args: args[0] === "retention" ? args : ["settings", ...args],
    flags,
    options: { profile: "test", server: "https://test.example", token: "test", output: "json" },
    getDefault: async () => undefined,
    setDefault: async () => {},
    createApiClient: () => {
      throw new Error("Unused");
    },
    fetch: async (path, init) => {
      requests.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      return Response.json(
        path.includes("/catalog") && args[0] === "set"
          ? {
              settings: [
                {
                  key: args[1],
                  kind: args[1]?.includes("secret") ? "secret" : "string",
                  group: "test",
                  stored: "none",
                  storedValuePresent: false,
                  envBacked: true,
                },
              ],
            }
          : args[0] === "retention" && path === "/api/gateway/settings"
            ? [
                { key: "gateway.telemetry_event_retention_days", value: 7 },
                { key: "gateway.telemetry_rollup_retention_days", value: 90 },
              ]
            : result,
      );
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
  return { code, output, requests: args[0] === "set" ? requests.filter((request) => !request.path.includes("/catalog")) : requests };
};
test("status requires --env and preserves JSON with nonzero attention", async () => {
  await expect(invoke(["status"], {}, {})).rejects.toThrow("--env");
  for (const needsAttention of [false, true]) {
    const result = { needsAttention, processes: [{ appId: "core", status: "ok", settings: [] }] };
    expect(await invoke(["status"], { env: true }, result)).toEqual({
      code: needsAttention ? 1 : 0,
      output: [result],
      requests: [{ path: "/api/admin/core/settings/env/status", body: null }],
    });
  }
});
test("setting repairs require JSON and confirmation and carry explicit replacement intent", async () => {
  await expect(invoke(["set", "gateway.trusted_proxies"], { value: "[]" }, {})).rejects.toThrow("--yes");
  await expect(invoke(["set", "gateway.trusted_proxies"], { value: "invalid", yes: true }, {})).rejects.toThrow("JSON");
  expect(
    (await invoke(["set", "gateway.trusted_proxies"], { value: '["127.0.0.1"]', yes: true, "replace-unreadable": true }, {})).requests,
  ).toEqual([
    {
      path: "/api/admin/core/settings",
      body: { updates: { "gateway.trusted_proxies": ["127.0.0.1"] }, replaceUnreadable: ["gateway.trusted_proxies"] },
    },
  ]);
  expect((await invoke(["set", "mail.workflow_ai_body_max_chars"], { value: "12000", app: "mail", yes: true }, {})).requests).toEqual([
    { path: "/api/admin/core/settings/env/mail/mail.workflow_ai_body_max_chars", body: { value: 12000, replaceUnreadable: false } },
  ]);
});

test("setting inventory strips every supplied value and secret writes reject argv", async () => {
  const row = { key: "app.secret", kind: "secret", group: "app", stored: "readable", storedValuePresent: true, envBacked: false };
  expect((await invoke(["list"], {}, { settings: [{ ...row, value: "private", default: "private" }] })).output).toEqual([
    { settings: [row] },
  ]);
  expect((await invoke(["show", "app.secret"], {}, { settings: [row] })).output).toEqual([row]);
  await expect(invoke(["set", "app.secret"], { value: '"private"', yes: true }, {})).rejects.toThrow("--from");
});

test("retention composes the owning settings without exposing unrelated settings", async () => {
  const result = await invoke(["retention", "show"], {}, { days: 30 });
  expect(result.output).toEqual([{ logs: { days: 30 }, events: { days: 7 }, rollups: { days: 90 } }]);
});
