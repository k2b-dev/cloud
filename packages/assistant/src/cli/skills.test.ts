import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiSkill } from "@k2b/cloud/ai";
import { parseAiSkillMarkdown, serializeAiSkillMarkdown } from "@k2b/cloud/ai/browser";
import type { CloudCliContext } from "@k2b/cloud/cli";
import assistant from "../cli";

const originalCwd = process.cwd();
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cld-skill-sync-"));
  process.chdir(directory);
});
afterEach(() => {
  process.chdir(originalCwd);
  rmSync(directory, { recursive: true, force: true });
});

const fixture = (): AiSkill => ({
  id: "Sk2345",
  shortId: "Sk2345",
  name: "weekly-status",
  description: "Summarize recent\nwork.",
  instructions: "Read [Style](references/style.md).",
  extraFrontmatter: { "disable-model-invocation": true, vendor: { b: 2, a: 1 } },
  references: [{ path: "references/style.md", content: "Be concise.\n" }],
  referenceCount: 1,
  source: null,
  permission: "admin",
  enabled: true,
  manualOnly: true,
  revision: 3,
  createdAt: "",
  updatedAt: "",
});

const context = (args: string[], cloud?: AiSkill, output: CloudCliContext["options"]["output"] = "text") => {
  const printed: string[] = [];
  const values: unknown[] = [];
  const tables: Parameters<CloudCliContext["table"]>[0][] = [];
  const requests: { path: string; method: string; body: unknown }[] = [];
  const ctx: CloudCliContext = {
    args,
    flags: {},
    options: { profile: "test", server: "https://cloud.example", token: "test", output },
    getDefault: async () => undefined,
    setDefault: async () => {},
    createApiClient: () => {
      throw new Error("Unused");
    },
    fetch: async (path, init) => {
      const method = init?.method ?? "GET";
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ path, method, body });
      if (method === "GET") {
        if (path.startsWith("/api/ai/skills?") || path === "/api/ai/skills") return Response.json({ skills: cloud ? [cloud] : [] });
        if (path === "/api/ai/skills/Sk2345" && cloud) return Response.json({ skill: cloud });
      }
      if (method === "POST" || method === "PUT") return Response.json({ skill: { ...fixture(), revision: method === "POST" ? 1 : 4 } });
      throw new Error(`Unexpected request ${method} ${path}`);
    },
    readJson: (response) => response.json(),
    print: (value = "") => {
      printed.push(value);
    },
    write: async () => {},
    error: () => {},
    json: (value) => {
      values.push(value);
    },
    jsonLine: (value) => {
      values.push(value);
    },
    table: (rows) => {
      tables.push(rows);
    },
  };
  return { ctx, printed, values, tables, requests };
};

const folder = async (skill = fixture(), dir = "source") => {
  await mkdir(join(dir, "references"), { recursive: true });
  await writeFile(join(dir, "SKILL.md"), serializeAiSkillMarkdown(skill));
  for (const reference of skill.references) await writeFile(join(dir, reference.path), reference.content);
  return dir;
};

test("skills list shows source, state, start mode and a one-line description", async () => {
  const cloud = { ...fixture(), source: { appId: "app", appName: "App" }, enabled: false };
  const session = context(["skills", "list"], cloud);
  session.ctx.flags.search = "weekly";
  await assistant.run(session.ctx);
  expect(session.requests).toEqual([{ path: "/api/ai/skills?q=weekly", method: "GET", body: undefined }]);
  expect(session.tables).toEqual([
    [{ name: "weekly-status", id: "Sk2345", source: "App", enabled: "no", start: "selected", description: "Summarize recent work." }],
  ]);
  expect(assistant.help?.()).toContain("List Cloud Skills and move them to and from Agent Skills folders");
  const automatic = context(["skills", "list"], { ...fixture(), manualOnly: false });
  await assistant.run(automatic.ctx);
  expect(automatic.tables[0]?.[0]).toMatchObject({ source: "-", enabled: "yes", start: "auto" });
});

test.each(["json", "jsonl"] as const)("skills list supports %s", async (output) => {
  const cloud = fixture();
  const session = context(["skills", "list"], cloud, output);
  await assistant.run(session.ctx);
  expect(session.printed).toEqual([]);
  expect(session.values).toHaveLength(1);
  if (output === "json") expect(session.values).toEqual([{ skills: [cloud] }]);
  else expect(session.values[0]).toMatchObject({ name: cloud.name, start: "selected" });
});

test("push creates a portable Skill, follows a folder symlink and reports bounded skipped paths", async () => {
  const dir = await folder();
  for (const subdir of ["scripts", "assets", "agents", "references/nested", ".private"]) await mkdir(join(dir, subdir));
  for (const path of ["LICENSE", "references/API.md", "references/data.json", ".secret"]) await writeFile(join(dir, path), "Skip");
  await symlink(join(directory, dir), "linked");
  const session = context(["skills", "push", "linked"]);
  await assistant.run(session.ctx);
  expect(session.requests[1]).toMatchObject({
    method: "POST",
    path: "/api/ai/skills",
    body: {
      ...parseAiSkillMarkdown(serializeAiSkillMarkdown(fixture())),
      references: fixture().references,
    },
  });
  expect(session.printed.join("\n")).toContain("Created Cloud Skill weekly-status.");
  expect(session.printed.join("\n")).toContain(
    "Not pushed: LICENSE, agents/, assets/, references/API.md, references/data.json, references/nested/, scripts/.",
  );
});

test("push fails clearly if SKILL.md is missing", async () => {
  await mkdir("empty");
  const session = context(["skills", "push", "empty"]);
  await expect(assistant.run(session.ctx)).rejects.toThrow("No SKILL.md in empty.");
  expect(session.requests).toEqual([]);
});

test("push updates with expectedRevision and reports removed references", async () => {
  const cloud = fixture();
  cloud.references.push({ path: "references/old.md", content: "Old" });
  const dir = await folder({ ...fixture(), instructions: "Changed." });
  const session = context(["skills", "push", dir], cloud);
  await assistant.run(session.ctx);
  expect(session.requests[2]).toMatchObject({
    method: "PUT",
    path: "/api/ai/skills/Sk2345",
    body: { expectedRevision: 3, instructions: "Changed.", references: fixture().references },
  });
  expect(session.printed.join("\n")).toContain("Updated Cloud Skill weekly-status to revision 4.\nRemoved from Cloud: references/old.md.");
});

test("push unchanged ignores nested key and reference order and sends no mutation", async () => {
  const cloud = fixture();
  cloud.references.push({ path: "references/a.md", content: "A" });
  const local = {
    ...cloud,
    extraFrontmatter: { vendor: { a: 1, b: 2 }, "disable-model-invocation": true },
    references: [...cloud.references].reverse(),
  };
  const session = context(["skills", "push", await folder(local)], cloud);
  await assistant.run(session.ctx);
  expect(session.requests.map((request) => request.method)).toEqual(["GET", "GET"]);
  expect(session.printed).toEqual(["Cloud Skill weekly-status is already up to date (revision 3)."]);
});

test("push refuses a read-only Skill before reading detail or sending changes", async () => {
  const session = context(["skills", "push", await folder()], { ...fixture(), permission: "read" });
  await expect(assistant.run(session.ctx)).rejects.toThrow('You can use the Cloud Skill "weekly-status" but not change it.');
  expect(session.requests).toHaveLength(1);
});

test.each(["json", "jsonl"] as const)("push supports %s without text on stdout", async (output) => {
  const session = context(["skills", "push", await folder()], undefined, output);
  await assistant.run(session.ctx);
  expect(session.printed).toEqual([]);
  expect(session.values).toEqual([
    { action: "created", skill: { id: "Sk2345", name: "weekly-status", revision: 1 }, skipped: [], removedReferences: [] },
  ]);
});

test("pull defaults to .agents/skills/name and preserves frontmatter and relative links", async () => {
  const session = context(["skills", "pull", "weekly-status"], fixture());
  await assistant.run(session.ctx);
  expect(session.printed).toEqual(["Pulled weekly-status (revision 3, 1 reference) to .agents/skills/weekly-status."]);
  expect(parseAiSkillMarkdown(await Bun.file(".agents/skills/weekly-status/SKILL.md").text())).toEqual(
    parseAiSkillMarkdown(serializeAiSkillMarkdown(fixture())),
  );
  expect(await Bun.file(".agents/skills/weekly-status/references/style.md").text()).toBe("Be concise.\n");
});

test("pull accepts a short ID after trying the exact name", async () => {
  const session = context(["skills", "pull", "Sk2345", "target"], fixture());
  await assistant.run(session.ctx);
  expect(session.requests.map((request) => request.path)).toEqual(["/api/ai/skills?q=Sk2345", "/api/ai/skills/Sk2345"]);
  expect(await Bun.file("target/SKILL.md").exists()).toBe(true);
});

test.each(["SKILL.md", "references/style.md"])("pull refuses existing %s before writing any files", async (existing) => {
  await mkdir("target/references", { recursive: true });
  await writeFile(join("target", existing), "Keep");
  const session = context(["skills", "pull", "weekly-status", "target"], fixture());
  await expect(assistant.run(session.ctx)).rejects.toThrow("already exists. Use --force");
  expect(await Bun.file(join("target", existing)).text()).toBe("Keep");
  expect(await Bun.file(join("target", existing === "SKILL.md" ? "references/style.md" : "SKILL.md")).exists()).toBe(false);
});

test("pull --force replaces Skill files and keeps scripts and old references", async () => {
  await folder({ ...fixture(), instructions: "Old" }, "target");
  await mkdir("target/scripts");
  await writeFile("target/scripts/run.sh", "Keep script");
  await writeFile("target/references/extra.md", "Keep reference");
  const session = context(["skills", "pull", "weekly-status", "target"], fixture());
  session.ctx.flags.force = true;
  await assistant.run(session.ctx);
  expect(await Bun.file("target/scripts/run.sh").text()).toBe("Keep script");
  expect(await Bun.file("target/references/extra.md").text()).toBe("Keep reference");
  expect(parseAiSkillMarkdown(await Bun.file("target/SKILL.md").text()).instructions).toBe(fixture().instructions);
});

test("pull --force refuses an occupied references directory before replacing SKILL.md", async () => {
  await mkdir("target");
  await writeFile("target/SKILL.md", "Keep original");
  await writeFile("target/references", "Keep unrelated file");
  const session = context(["skills", "pull", "weekly-status", "target"], fixture());
  session.ctx.flags.force = true;
  await expect(assistant.run(session.ctx)).rejects.toThrow();
  expect(await Bun.file("target/SKILL.md").text()).toBe("Keep original");
  expect(await Bun.file("target/references").text()).toBe("Keep unrelated file");
});

test.each(["json", "jsonl"] as const)("pull supports %s", async (output) => {
  const session = context(["skills", "pull", "weekly-status", "target"], fixture(), output);
  await assistant.run(session.ctx);
  expect(session.printed).toEqual([]);
  expect(session.values).toEqual([
    { skill: { id: "Sk2345", name: "weekly-status", revision: 3 }, dir: "target", files: ["SKILL.md", "references/style.md"] },
  ]);
});

test("pull then push is unchanged", async () => {
  const cloud = fixture();
  // Cloud normalizes descriptions when saving.
  cloud.description = "Summarize recent work.";
  await assistant.run(context(["skills", "pull", cloud.name], cloud).ctx);
  const session = context(["skills", "push", `.agents/skills/${cloud.name}`], cloud, "json");
  await assistant.run(session.ctx);
  expect(session.requests.every((request) => request.method === "GET")).toBe(true);
  expect(session.values).toEqual([
    { action: "unchanged", skill: { id: "Sk2345", name: cloud.name, revision: 3 }, skipped: [], removedReferences: [] },
  ]);
  expect(await readdir(`.agents/skills/${cloud.name}`)).toEqual(["SKILL.md", "references"]);
});
