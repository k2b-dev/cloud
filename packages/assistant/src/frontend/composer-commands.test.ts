import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { AiProject } from "@k2b/cloud/ai";

const root = mkdtempSync(join(tmpdir(), "assistant-slash-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));
const { assistantApi } = await import("../api/client");
const { assistantComposerCommands } = await import("./composer-commands");

afterEach(() => mock.restore());

const project: AiProject = {
  id: "project-1", shortId: "Ab1234", name: "Invoices", description: "Accounts", icon: "ti ti-folders",
  instructions: "", defaultModelProfileId: null, permission: "read", revision: 1, createdAt: "", updatedAt: "",
};

test("Project slash selection assigns once and disappears for an assigned chat", async () => {
  const assigned: string[] = [];
  const input = { query: "project inv", signal: new AbortController().signal, locale: "en", projects: [project],
    running: false, assignProject: async (id: string) => { assigned.push(id); } };
  const commands = await assistantComposerCommands(input);
  expect(commands.map(command => command.label)).toEqual(["Invoices"]);
  await commands[0]!.action?.({ setValue() {}, submit() {}, focus() {} });
  expect(assigned).toEqual([project.id]);
  expect(await assistantComposerCommands({ ...input, projectId: project.id })).toEqual([]);
  expect((await assistantComposerCommands({ ...input, running: true }))[0]?.disabled).toBe(true);
});

test("Skills are explicit stable references; disabled Skills are excluded", async () => {
  const skill = { id: "skill-1", shortId: "Sk1234", name: "invoices", description: "Match invoices", permission: "read" as const,
    enabled: true, revision: 1, referenceCount: 0, createdAt: "", updatedAt: "" };
  const list = spyOn(assistantApi, "listSkills").mockResolvedValue([skill, { ...skill, id: "disabled", enabled: false }]);
  const signal = new AbortController().signal;
  const commands = await assistantComposerCommands({ query: "skill invioces", signal, locale: "en", projects: [], running: false, assignProject: async () => {} });
  expect(list).toHaveBeenCalledWith(signal, "invioces");
  expect(commands).toHaveLength(1);
  expect(commands[0]?.action).toBeUndefined();
  expect(commands[0]?.mention?.data).toMatchObject({ kind: "resource", ref: { type: "core.ai.skill", id: "Sk1234" } });
});
