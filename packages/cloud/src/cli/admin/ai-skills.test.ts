import { expect, test } from "bun:test";
import { defineCliCommands } from "../commands";
import type { CloudCliContext, CloudCliFlags } from "../index";
import { aiSkillCommands } from "./ai-skills";

const module = defineCliCommands({ name: "admin", summary: "Skills", commands: aiSkillCommands });
const invoke = async (args: string[], flags: CloudCliFlags = {}) => {
  const requests: { path: string; body?: string | null }[] = [];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "http://test", token: "test", output: "json" },
    getDefault: async () => undefined,
    setDefault: async () => {},
    createApiClient: () => {
      throw new Error("unused");
    },
    fetch: async (path, init) => {
      requests.push({ path, body: typeof init?.body === "string" ? init.body : null });
      return Response.json({ updated: true, items: [] });
    },
    readJson: async (response) => response.json(),
    print: () => {},
    write: async () => {},
    error: () => {},
    json: () => {},
    jsonLine: () => {},
    table: () => {},
  };
  await module.run(ctx);
  return requests;
};

test("reset forwards the reviewed revision and requires confirmation", async () => {
  const appVersion = "a".repeat(64);
  const requests = await invoke(["ai", "skills", "reset", "sKl234"], { revision: "7", "app-version": appVersion, yes: true });
  expect(requests[0]!.path).toBe("/api/admin/core/ai-skills/sKl234/reset");
  expect(JSON.parse(requests[0]!.body!)).toEqual({ expectedRevision: 7, expectedAppVersion: appVersion, confirmed: true });
  await expect(invoke(["ai", "skills", "reset", "sKl234"], { revision: "7", "app-version": appVersion })).rejects.toThrow("--yes");
  await expect(invoke(["ai", "skills", "reset", "sKl234"], { revision: "7", yes: true })).rejects.toThrow();
  await expect(invoke(["ai", "skills", "reset", "sKl234"], { yes: true })).rejects.toThrow();
});
test("restore and adopt target exactly one app Skill with confirmation", async () => {
  for (const action of ["restore", "adopt"]) {
    const requests = await invoke(["ai", "skills", action, "inventory", "inventory-counting"], { yes: true });
    expect(requests[0]!.path).toBe(`/api/admin/core/ai-skills/apps/inventory/skills/inventory-counting/${action}`);
    expect(JSON.parse(requests[0]!.body!)).toEqual({ confirmed: true });
    await expect(invoke(["ai", "skills", action, "inventory", "inventory-counting"])).rejects.toThrow("--yes");
  }
});
test("list preserves filters", async () => {
  const list = await invoke(["ai", "skills", "list"], { page: "2", "per-page": "10", search: "cloud-mail" });
  const url = new URL(list[0]!.path, "http://test");
  expect(url.searchParams.get("page")).toBe("2");
  expect(url.searchParams.get("perPage")).toBe("10");
  expect(url.searchParams.get("search")).toBe("cloud-mail");
});
