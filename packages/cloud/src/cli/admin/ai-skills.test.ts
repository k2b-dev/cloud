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
      return Response.json({ updated: true });
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

test("admin Skill commands forward explicit confirmation and both revisions to shared routes", async () => {
  for (const mode of ["associate", "reset"]) {
    const flags = { template: "core:skill-creator", "template-version": "2", revision: "7", yes: true };
    const requests = await invoke(["ai", "skills", mode, "sKl234"], flags);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toBe("/api/admin/core/ai-skills/sKl234/template");
    expect(JSON.parse(requests[0]!.body!)).toEqual({
      templateId: "core:skill-creator",
      templateVersion: 2,
      expectedRevision: 7,
      mode,
      confirmed: true,
    });
    await expect(invoke(["ai", "skills", mode, "sKl234"], { ...flags, yes: false })).rejects.toThrow("--yes");
  }
  await expect(invoke(["ai", "skills", "reset", "sKl234"], { template: "core:skill-creator", yes: true })).rejects.toThrow();
});

test("admin Skill reads preserve list filters and discover current templates", async () => {
  const list = await invoke(["ai", "skills", "list"], { page: "2", "per-page": "10", search: "cloud-mail" });
  const url = new URL(list[0]!.path, "http://test");
  expect(url.searchParams.get("page")).toBe("2");
  expect(url.searchParams.get("perPage")).toBe("10");
  expect(url.searchParams.get("search")).toBe("cloud-mail");
  expect((await invoke(["ai", "skills", "templates"]))[0]!.path).toBe("/api/admin/core/ai-skills/templates");
});
