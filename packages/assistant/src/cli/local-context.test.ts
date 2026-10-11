import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AI_SKILL_DESCRIPTION_MAX_CHARS,
  AI_SKILL_EXTRA_FRONTMATTER_MAX_CHARS,
  AI_SKILL_INSTRUCTIONS_MAX_CHARS,
  AI_SKILL_NAME_MAX_CHARS,
  AiLocalContextSchema,
} from "@k2b/cloud/ai/browser";
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

test("Skill discovery respects precedence and aliases, and marks manual-only catalog entries", async () => {
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
  expect(localSkillCatalog(context).map((item) => item.name)).toEqual(["finance", "manual", "shared"]);
  expect(localSkillCatalog(context)[1]).toEqual({ name: "manual", description: "Manual only", scope: "global", manualOnly: true });
  expect(AiLocalContextSchema.parse({ skills: localSkillCatalog(context) }).skills[1]?.manualOnly).toBeTrue();
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
  for (let i = 0; i < 65; i++) await skill(home, `skill-${i}`, `description: Useful\ndisable-model-invocation: ${i % 2 === 0}`);
  const read = createLocalContextReader({
    workspace,
    home,
    ctx: { getDefault: async () => undefined, setDefault: async () => {} },
    askTrust: async () => undefined,
  });
  const context = await read();
  expect(localSkillCatalog(context)).toHaveLength(64);
  expect(context.problems).toHaveLength(1);
  expect(context.problems[0]?.path).toBe(context.skills[64]?.path);
  expect(await readLocalSkill(context.skills[0]!)).toMatchObject({ instructions: "Use this Skill." });
});

test.each(["outside", "secrets/.env", ".ssh/key", "missing"])(
  "AGENTS.md symlink to %s is skipped and reported without project context",
  async (destination) => {
    const target = destination === "outside" ? join(root, "outside.md") : join(project, destination);
    await mkdir(join(target, ".."), { recursive: true });
    if (destination !== "missing") await writeFile(target, "must not be instructions");
    const path = join(workspace, "AGENTS.md");
    await symlink(target, path);
    const context = await discoverLocalContext(workspace, home);
    expect(context.instructions).toEqual([]);
    expect(context.instructionPaths).toEqual([]);
    expect(context.hasProjectContext).toBeFalse();
    expect(context.problems).toEqual([{ path, error: "AGENTS.md points outside the project or to a protected file; not loaded" }]);
  },
);

test("AGENTS.md symlink to an ordinary file inside the real project root loads", async () => {
  await writeFile(join(project, "rules.md"), "project instructions");
  const path = join(workspace, "AGENTS.md");
  await symlink(join(project, "rules.md"), path);
  const context = await discoverLocalContext(workspace, home);
  expect(context.instructions).toEqual([{ path, content: "project instructions" }]);
  expect(context.hasProjectContext).toBeTrue();
  expect(context.problems).toEqual([]);
});

test("oversized sparse SKILL.md is rejected before discovery or selection reads", async () => {
  const directory = await skill(home, "large");
  const context = await discoverLocalContext(workspace, home);
  const path = join(directory, "SKILL.md");
  const file = await open(path, "r+");
  try {
    await file.truncate(
      4 *
        (AI_SKILL_NAME_MAX_CHARS +
          AI_SKILL_DESCRIPTION_MAX_CHARS +
          AI_SKILL_EXTRA_FRONTMATTER_MAX_CHARS +
          AI_SKILL_INSTRUCTIONS_MAX_CHARS) +
        129,
    );
  } finally {
    await file.close();
  }
  const oversized = await discoverLocalContext(workspace, home);
  expect(oversized.skills).toEqual([]);
  expect(oversized.problems).toEqual([{ path, error: "SKILL.md is larger than a Skill can be; not loaded" }]);
  await expect(readLocalSkill(context.skills[0]!, workspace)).rejects.toThrow("SKILL.md is larger than a Skill can be; not loaded");
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
