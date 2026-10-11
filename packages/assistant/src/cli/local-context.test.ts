import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiLocalContextSchema } from "@k2b/cloud/ai/browser";
import { createLocalContextReader, discoverLocalContext, localSkillCatalog, readLocalSkill } from "./local-context";

let root: string;
let project: string;
let workspace: string;
let home: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cld-context-test-"));
  project = join(root, "project");
  workspace = join(project, "work");
  home = join(root, "home");
  await mkdir(workspace, { recursive: true });
  await mkdir(home);
  await writeFile(join(project, ".git"), "gitdir: elsewhere");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const skill = async (base: string, name: string, fields = "description: A useful Skill", body = "Use this Skill.") => {
  const directory = join(base, ".agents/skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\n${fields}\n---\n${body}`);
  return directory;
};

test("nearest git root bounds exact AGENTS.md discovery, ordered root first", async () => {
  await writeFile(join(root, "AGENTS.md"), "not in scope");
  await writeFile(join(project, "AGENTS.md"), "root instructions");
  await writeFile(join(workspace, "AGENTS.md"), "closest instructions");
  await writeFile(join(workspace, "agents.md"), "wrong name");
  const context = await discoverLocalContext(workspace, home);
  expect(context.root).toBe(project);
  expect(context.instructions).toEqual([
    { path: join(project, "AGENTS.md"), content: "root instructions" },
    { path: join(workspace, "AGENTS.md"), content: "closest instructions" },
  ]);
});

test("an empty .git folder is no repository, while one with HEAD is", async () => {
  await rm(join(project, ".git"));
  await mkdir(join(project, ".git"));
  expect((await discoverLocalContext(workspace, home)).root).toBe(workspace);
  await writeFile(join(project, ".git/HEAD"), "ref: refs/heads/main\n");
  expect((await discoverLocalContext(workspace, home)).root).toBe(project);
});

test("without git, only the workspace is a context root", async () => {
  await rm(join(project, ".git"));
  await writeFile(join(project, "AGENTS.md"), "above workspace");
  const context = await discoverLocalContext("/", home);
  expect(context.root).toBe("/");
  expect(context.instructions).toEqual([]);
});

test("32 KiB budget favors the closest file and truncates UTF-8 within the shared contract", async () => {
  await writeFile(join(project, "AGENTS.md"), "ä".repeat(32_768));
  await writeFile(join(workspace, "AGENTS.md"), "closest");
  const context = await discoverLocalContext(workspace, home);
  expect(context.shortened).toBeTrue();
  expect(context.instructions[0]?.content.endsWith("\n[shortened by cld: 32 KiB limit]")).toBeTrue();
  expect(context.instructions[1]?.content).toBe("closest");
  expect(AiLocalContextSchema.safeParse({ instructions: context.instructions }).success).toBeTrue();
});

test("Skill discovery is lenient, respects precedence and aliases, and hides manual invocation from the catalog", async () => {
  await skill(workspace, "finance", "description: Closest\nunknown-field: fine\nallowed-tools: [ignored]");
  await skill(project, "finance", "description: Parent");
  await skill(home, "finance", "description: Global");
  await skill(home, "manual", "description: Manual only\ndisable-model-invocation: true");
  await skill(home, "cloud-cli");
  const folder = await skill(home, "shared");
  await symlink(folder, join(home, ".agents/skills/shared-alias"));
  await skill(project, "broken", "description: [invalid");
  const context = await discoverLocalContext(workspace, home);
  expect(context.skills.map((item) => item.name)).toEqual(["finance", "manual", "shared"]);
  expect(localSkillCatalog(context).map((item) => item.name)).toEqual(["finance", "shared"]);
  expect(context.hidden).toEqual(
    expect.arrayContaining([
      { name: "finance", scope: "project", reason: "hidden by the project Skill" },
      { name: "cloud-cli", scope: "global", reason: "cld reaches Cloud through its own tools" },
    ]),
  );
  expect(context.problems[0]?.error).toContain("invalid frontmatter");
});

test("invalid names and descriptions are skipped, long descriptions and name mismatches warn", async () => {
  await skill(home, "invalid", "description: ''");
  const folder = await skill(home, "folder", `description: ${"x".repeat(1100)}`);
  await writeFile(join(folder, "SKILL.md"), `---\nname: different\ndescription: ${"x".repeat(1100)}\n---\nbody`);
  const context = await discoverLocalContext(workspace, home);
  expect(context.skills).toHaveLength(1);
  expect(context.skills[0]?.description).toHaveLength(1024);
  expect(context.problems.map((problem) => problem.error)).toContain("description shortened to 1024 characters");
});

test("declining trust excludes project instructions and revives a shadowed global Skill for the session", async () => {
  await skill(project, "shared");
  await skill(home, "shared", "description: Global");
  await writeFile(join(project, "AGENTS.md"), "root");
  let asked = 0;
  const read = createLocalContextReader({
    workspace,
    home,
    ctx: {
      getDefault: async () => "broken JSON",
      setDefault: async () => {
        throw new Error("Must not save");
      },
    },
    askTrust: async () => {
      asked++;
      return undefined;
    },
  });
  const context = await read();
  await read();
  expect(asked).toBe(1);
  expect(context.instructions).toEqual([]);
  expect(context.skills).toMatchObject([{ name: "shared", scope: "global", description: "Global" }]);
  expect(context.trusted).toBeFalse();
});

test("trust persists the root realpath per profile and rereads edits on every send", async () => {
  const path = join(project, "AGENTS.md");
  await writeFile(path, "first");
  let saved: string | undefined;
  let asked = 0;
  const ctx = {
    getDefault: async () => saved,
    setDefault: async (key: string, value: string | undefined) => {
      expect(key).toBe("assistant.trustedFolders");
      saved = value;
    },
  };
  const read = createLocalContextReader({
    workspace,
    home,
    ctx,
    askTrust: async () => {
      asked++;
      return "folder";
    },
  });
  expect((await read()).instructions[0]?.content).toBe("first");
  expect(saved).toBe(JSON.stringify([project]));
  await writeFile(path, "second");
  expect((await read()).instructions[0]?.content).toBe("second");
  expect(asked).toBe(1);
  const next = createLocalContextReader({
    workspace,
    home,
    ctx,
    askTrust: async () => {
      throw new Error("Already trusted");
    },
  });
  expect((await next()).trusted).toBeTrue();
});

test("project context appearing later asks once; global Skills alone never ask", async () => {
  await skill(home, "global");
  let asked = 0;
  const read = createLocalContextReader({
    workspace,
    home,
    ctx: { getDefault: async () => undefined, setDefault: async () => {} },
    askTrust: async () => {
      asked++;
      return "session";
    },
  });
  expect((await read()).skills).toHaveLength(1);
  expect(asked).toBe(0);
  await skill(project, "new");
  expect((await read()).trusted).toBeTrue();
  await read();
  expect(asked).toBe(1);
});

test("catalog is bounded to 64 while explicit selections return only the Skill body", async () => {
  for (let i = 0; i < 65; i++) await skill(home, `skill-${i}`);
  const read = createLocalContextReader({
    workspace,
    home,
    ctx: { getDefault: async () => undefined, setDefault: async () => {} },
    askTrust: async () => undefined,
  });
  const context = await read();
  expect(localSkillCatalog(context)).toHaveLength(64);
  expect(context.problems).toHaveLength(1);
  expect(await readLocalSkill(context.skills[0]!)).toMatchObject({ instructions: "Use this Skill." });
});

test("a tiny remaining instruction budget drops farther files without sending empty instructions", async () => {
  await writeFile(join(workspace, "AGENTS.md"), "x".repeat(32 * 1024 - 5));
  await writeFile(join(project, "AGENTS.md"), "farther instructions");
  const context = await discoverLocalContext(workspace, home);
  expect(context.shortened).toBeTrue();
  expect(context.instructions).toHaveLength(1);
  expect(context.instructions[0]?.path).toBe(join(workspace, "AGENTS.md"));
  expect(AiLocalContextSchema.safeParse({ instructions: context.instructions }).success).toBeTrue();
});
