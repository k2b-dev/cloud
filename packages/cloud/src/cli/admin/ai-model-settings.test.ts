import { afterAll, describe, expect, test } from "bun:test";
import { defineCliCommands } from "../commands";
import type { CloudCliContext, CloudCliFlags } from "../index";
import { aiQuotaCommands } from "./ai-quotas";

const module = defineCliCommands({ name: "admin", summary: "AI", commands: aiQuotaCommands });
const state = {
  id: "model/id",
  reasoningEffort: "medium",
  extraBody: { custom: true },
  requestHeaderNames: ["X-Key"],
  revision: "current",
};
const invoke = async (args: string[], flags: CloudCliFlags) => {
  const requests: { path: string; body: unknown }[] = [];
  const lines: string[] = [];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "http://test", token: "test", output: "json" },
    getDefault: async () => undefined,
    setDefault: async () => undefined,
    createApiClient: () => {
      throw new Error("unused");
    },
    fetch: async (path, init) => {
      requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json({ ...state, requestHeaders: { "X-Key": "should-never-print" } });
    },
    readJson: async (response) => response.json(),
    print: (line = "") => {
      lines.push(line);
    },
    write: async (line) => {
      lines.push(line);
    },
    error: (line) => {
      lines.push(line);
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
  return { requests, lines };
};
const args = ["ai", "models", "settings"];
const file = `${process.cwd()}/.local/ai-model-settings-headers-${crypto.randomUUID()}.json`;
afterAll(async () => {
  await Bun.file(file).delete();
});
describe("model request settings CLI", () => {
  test("get prints masked JSON only", async () => {
    const result = await invoke([...args, "get"], { id: "model/id" });
    expect(result.requests[0]?.path).toBe("/api/admin/core/ai-quotas/models/model%2Fid/settings");
    expect(JSON.parse(result.lines[0]!)).toEqual(state);
    expect(result.lines.join("")).not.toContain("should-never-print");
  });
  test("set sends only selected fields, reads revision first and supports header files", async () => {
    await Bun.write(file, JSON.stringify({ "X-Key": "file-secret", "X-Old": null }));
    const result = await invoke([...args, "set"], {
      id: "model/id",
      "thinking-level": "low",
      "extra-body": '{"custom":false}',
      "headers-file": file,
      yes: true,
    });
    expect(result.requests).toHaveLength(2);
    expect(result.requests[1]?.body).toEqual({
      expected: "current",
      reasoningEffort: "low",
      extraBody: { custom: false },
      requestHeaders: { "X-Key": "file-secret", "X-Old": null },
    });
    expect(result.lines.join("")).not.toContain("file-secret");
    const headersOnly = await invoke([...args, "set"], { id: "model/id", headers: '{"X-Key":null}', yes: true });
    expect(headersOnly.requests[1]?.body).toEqual({ expected: "current", requestHeaders: { "X-Key": null } });
  });
  test("explicit clear flags set nulls and clear all headers", async () => {
    const result = await invoke([...args, "set"], {
      id: "model/id",
      "clear-thinking-level": true,
      "clear-extra-body": true,
      "clear-headers": true,
      yes: true,
    });
    expect(result.requests[1]?.body).toEqual({ expected: "current", reasoningEffort: null, extraBody: null, clearRequestHeaders: true });
  });
  test("requires confirmation, rejects conflicting inputs and keeps parse errors secret-safe", async () => {
    await expect(invoke([...args, "set"], { id: "model/id", "thinking-level": "low" })).rejects.toThrow("--yes");
    await expect(
      invoke([...args, "set"], { id: "model/id", "thinking-level": "low", "clear-thinking-level": true, yes: true }),
    ).rejects.toThrow("Choose");
    await expect(invoke([...args, "set"], { id: "model/id", "extra-body": "{}", "clear-extra-body": true, yes: true })).rejects.toThrow(
      "Choose",
    );
    await expect(invoke([...args, "set"], { id: "model/id", stdin: true, "headers-stdin": true, yes: true })).rejects.toThrow(
      "one JSON input",
    );
    await expect(invoke([...args, "set"], { id: "model/id", headers: '"hidden-secret" broken', yes: true })).rejects.toThrow(
      "Invalid extra headers JSON.",
    );
  });
});
