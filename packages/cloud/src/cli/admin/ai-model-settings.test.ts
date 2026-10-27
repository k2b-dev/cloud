import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCliCommands } from "../commands";
import type { CloudCliContext, CloudCliFlags } from "../index";
import { aiModelCommands } from "./ai-models";

const module = defineCliCommands({ name: "admin", summary: "AI", commands: aiModelCommands });
const state = {
  id: "chat",
  extraBody: { custom: true },
  revision: 7,
  variants: [
    { id: "chat", reasoningEffort: null, revision: 2 },
    { id: "chat:deep", reasoningEffort: "medium", extraBody: { custom: true }, revision: 3 },
  ],
};
const createContext = (args: string[], flags: CloudCliFlags = {}, response = state) => {
  const requests: { path: string; method: string; body: unknown }[] = [];
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
      requests.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json(response);
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
  return { ctx, requests, lines };
};
describe("model and variant request settings CLI", () => {
  test("show reads model settings and its variants", async () => {
    const result = createContext(["ai", "models", "show", "chat"]);
    await module.run(result.ctx);
    expect(result.requests).toEqual([{ path: "/api/admin/core/ai/models/chat", method: "GET", body: null }]);
    expect(JSON.parse(result.lines[0]!)).toEqual(state);
  });
  test("updates only selected fields using model or variant revisions and supports input files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cloud-model-settings-"));
    try {
      const file = join(dir, "variant.json");
      const patch = { reasoningEffort: "low", extraBody: { custom: false } };
      await writeFile(file, JSON.stringify(patch));
      const result = createContext(["ai", "variants", "update", "chat:deep"], { "input-file": file, yes: true });
      await module.run(result.ctx);
      expect(result.requests).toEqual([
        { path: "/api/admin/core/ai/models/chat", method: "GET", body: null },
        { path: "/api/admin/core/ai/variants/chat%3Adeep", method: "PATCH", body: { ...patch, revision: 3 } },
      ]);
      const model = createContext(["ai", "models", "update", "chat"], { input: '{"extraBody":{"custom":false}}', yes: true });
      await module.run(model.ctx);
      expect(model.requests[1]).toEqual({
        path: "/api/admin/core/ai/models/chat",
        method: "PATCH",
        body: { extraBody: { custom: false }, revision: 7 },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("explicit nulls clear model parameters and variant overrides including the standard variant", async () => {
    const model = createContext(["ai", "models", "update", "chat"], { input: '{"extraBody":null}', yes: true });
    await module.run(model.ctx);
    expect(model.requests[1]?.body).toEqual({ extraBody: null, revision: 7 });
    for (const [id, revision] of [
      ["chat", 2],
      ["chat:deep", 3],
    ] as const) {
      const result = createContext(["ai", "variants", "update", id], {
        input: '{"reasoningEffort":null,"extraBody":null}',
        yes: true,
      });
      await module.run(result.ctx);
      expect(result.requests[1]?.body).toEqual({ reasoningEffort: null, extraBody: null, revision });
    }
  });
  test("requires confirmation and rejects invalid or obsolete fields before requests", async () => {
    const unconfirmed = createContext(["ai", "variants", "update", "chat:deep"], { input: '{"reasoningEffort":"low"}' });
    await expect(module.run(unconfirmed.ctx)).rejects.toThrow("--yes");
    expect(unconfirmed.requests).toHaveLength(0);
    for (const [area, input] of [
      ["variants", '{"reasoningEffort":"UPPER"}'],
      ["variants", '{"extraBody":{"messages":[]}}'],
      ["models", '{"reasoningEffort":"low"}'],
      ["models", '{"requestHeaders":{"X-Key":"value"}}'],
    ] as const) {
      const invalid = createContext(["ai", area, "update", "chat"], { input, yes: true });
      await expect(module.run(invalid.ctx)).rejects.toThrow();
      expect(invalid.requests).toHaveLength(0);
    }
    const conflicting = createContext(["ai", "models", "update", "chat"], { input: "{}", "input-file": "unused.json", yes: true });
    await expect(module.run(conflicting.ctx)).rejects.toThrow();
    expect(conflicting.requests).toHaveLength(0);
  });
  test("a removed variant does not write or print success", async () => {
    const result = createContext(["ai", "variants", "update", "chat:removed"], { input: '{"reasoningEffort":"low"}', yes: true });
    await expect(module.run(result.ctx)).rejects.toThrow("Variant not found");
    expect(result.requests).toHaveLength(1);
    expect(result.lines).toHaveLength(0);
  });
  test("help exposes the replacements and no profile settings or pricing subcommands", async () => {
    for (const area of ["models", "variants"]) {
      const result = createContext(["ai", area, "help"]);
      await module.run(result.ctx);
      const help = result.lines.join("\n");
      expect(help).toMatch(/\n  update\s/);
      expect(help).not.toMatch(/\n  (settings|pricing)\s/);
      const update = createContext(["ai", area, "update", "help"]);
      await module.run(update.ctx);
      expect(update.lines.join("\n")).toContain(`cld admin ai ${area} update`);
      expect(update.lines.join("\n")).toContain("--input-file");
      expect(result.requests).toHaveLength(0);
    }
  });
});
