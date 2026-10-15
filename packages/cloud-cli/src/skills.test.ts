import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_SKILL_FILES } from "./skill-source";
import { normalizeSkillTarget, referenceFolder, renderModulesTable, renderSkill, syncSkillTargets, writeSkillTarget } from "./skills";

const listFiles = async (directory: string, prefix = ""): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) files.push(...(await listFiles(join(directory, entry.name), `${prefix}${entry.name}/`)));
    else files.push(`${prefix}${entry.name}`);
  }
  return files.sort();
};

describe("cloud-cli skill targets", () => {
  test("the embedded core skill equals skills/cloud-cli", async () => {
    const source = new URL("../../../skills/cloud-cli/", import.meta.url).pathname;
    expect(Object.keys(CORE_SKILL_FILES).sort()).toEqual(await listFiles(source));
    for (const [path, content] of Object.entries(CORE_SKILL_FILES)) expect(content).toBe(await readFile(join(source, path), "utf8"));
  });

  test("renders the module table into the cld:modules block and keeps the rest", () => {
    const template = "# Skill\n\n<!-- cld:modules -->\nPLACEHOLDER\n<!-- /cld:modules -->\n\nTail\n";
    expect(renderSkill(template, [])).toContain("No module is installed");
    const rendered = renderSkill(template, [
      { profile: "work", name: "mail", version: "0.19.0", summary: "Mail | tools\nMore", digest: "d1" },
      { profile: "home", name: "notebooks", version: "0.18.2", summary: "Mail | tools\nMore", digest: "d2" },
    ]);
    expect(rendered).toContain("| home | notebooks | 0.18.2 | Mail \\| tools More | `references/notebooks/0.18.2/index.md` |");
    expect(rendered).toContain("| work | mail | 0.19.0 | Mail \\| tools More | `references/mail/0.19.0/index.md` |");
    expect(rendered).not.toContain("PLACEHOLDER");
    expect(rendered.startsWith("# Skill\n\n<!-- cld:modules -->\n")).toBe(true);
    expect(rendered.endsWith("<!-- /cld:modules -->\n\nTail\n")).toBe(true);
    expect(() => renderSkill("# no block", [])).toThrow("cld:modules");
    expect(referenceFolder("grids", "1.0.0+build/7")).toBe("references/grids/1.0.0_build_7/");
  });

  test("escapes every free-text table cell", () => {
    const table = renderModulesTable([
      { profile: "work|home\r\nnext", name: "mail", version: "1|2\n3", summary: "Mail|tools\rMore", digest: "d1" },
    ]);
    expect(table.split("\n")).toHaveLength(3);
    expect(table).toContain("| work\\|home next | mail | 1\\|2 3 | Mail\\|tools More | `references/mail/1_2_3/index.md` |");
  });

  test("dot versions keep module references separate from the core references", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cld-skills-dots-"));
    try {
      const root = join(dir, "plugins");
      const digest = "a".repeat(128);
      const references = join(root, "store", digest, "references");
      await mkdir(references, { recursive: true });
      await writeFile(join(references, "plugins.md"), "module plugins reference");
      await writeFile(join(references, "index.md"), "module index");
      for (const [version, segment] of [
        [".", "_"],
        ["..", "_."],
        [".hidden", "_hidden"],
      ] as const) {
        expect(referenceFolder("mail", version)).toBe(`references/mail/${segment}/`);
        const destination = await writeSkillTarget(
          join(dir, "skills"),
          [{ profile: "*", name: "mail", version, summary: "Mail", digest }],
          root,
        );
        expect(CORE_SKILL_FILES["references/plugins.md"]).toBe(await readFile(join(destination, "references", "plugins.md"), "utf8"));
        expect(await readFile(join(destination, "references", "mail", segment, "index.md"), "utf8")).toBe("module index");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("different bundles with the same module and version get their own reference folders", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cld-skills-collide-"));
    try {
      const root = join(dir, "plugins");
      const served = "a".repeat(128);
      const pkg = "b".repeat(128);
      for (const [digest, text] of [
        [served, "# Served inventory\n"],
        [pkg, "# Package inventory\n"],
      ] as const) {
        await mkdir(join(root, "store", digest, "references"), { recursive: true });
        await writeFile(join(root, "store", digest, "references", "index.md"), text);
      }
      const rows = [
        { profile: "p1", name: "inv", version: "1.0.0", summary: "Inventory", digest: served },
        { profile: "*", name: "inv", version: "1.0.0", summary: "Inventory", digest: pkg },
        { profile: "*", name: "mail", version: "1.0.0", summary: "Mail", digest: served },
      ];
      const written = await writeSkillTarget(join(dir, "skills"), rows, root);
      const skill = await readFile(join(written, "SKILL.md"), "utf8");
      expect(skill).toContain(`| p1 | inv | 1.0.0 | Inventory | \`references/inv/1.0.0+${"a".repeat(12)}/index.md\` |`);
      expect(skill).toContain(`| * | inv | 1.0.0 | Inventory | \`references/inv/1.0.0+${"b".repeat(12)}/index.md\` |`);
      expect(skill).toContain("| * | mail | 1.0.0 | Mail | `references/mail/1.0.0/index.md` |");
      expect(await readFile(join(written, "references", "inv", `1.0.0+${"a".repeat(12)}`, "index.md"), "utf8")).toBe(
        "# Served inventory\n",
      );
      expect(await readFile(join(written, "references", "inv", `1.0.0+${"b".repeat(12)}`, "index.md"), "utf8")).toBe(
        "# Package inventory\n",
      );
      expect(await readdir(join(written, "references", "inv"))).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writes the core skill plus one reference folder per installed module version and prunes the rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cld-skills-test-"));
    try {
      const root = join(dir, "plugins");
      for (const [digest, text] of [
        ["a".repeat(128), "# Mail 1\n"],
        ["b".repeat(128), "# Mail 2\n"],
      ] as const) {
        await mkdir(join(root, "store", digest, "references", "deep"), { recursive: true });
        await writeFile(join(root, "store", digest, "references", "index.md"), text);
        await writeFile(join(root, "store", digest, "references", "deep", "more.md"), "more\n");
      }
      const target = join(dir, "skills");
      await writeFile(join(dir, "keep.txt"), "untouched");
      const rows = [
        { profile: "a", name: "mail", version: "1.0.0", summary: "Mail | tools\nMore", digest: "a".repeat(128) },
        { profile: "b", name: "mail", version: "1.0.0", summary: "Mail | tools\nMore", digest: "a".repeat(128) },
        { profile: "b", name: "mail", version: "2.0.0", summary: "Mail | tools\nMore", digest: "b".repeat(128) },
      ];
      const written = await writeSkillTarget(target, rows, root);
      expect(written).toBe(join(target, "cloud-cli"));
      expect(await listFiles(written)).toEqual([
        "SKILL.md",
        "agents/openai.yaml",
        "references/mail/1.0.0/deep/more.md",
        "references/mail/1.0.0/index.md",
        "references/mail/2.0.0/deep/more.md",
        "references/mail/2.0.0/index.md",
        "references/plugins.md",
        "references/sign-in.md",
      ]);
      expect(await readFile(join(written, "SKILL.md"), "utf8")).toContain(
        "| b | mail | 2.0.0 | Mail \\| tools More | `references/mail/2.0.0/index.md` |",
      );

      // A later sync with fewer modules replaces the folder; stale versions and stray files go.
      await writeFile(join(written, "stray.md"), "stray");
      expect(await syncSkillTargets([target], rows.slice(0, 1), root)).toEqual([written]);
      expect(await listFiles(written)).toEqual([
        "SKILL.md",
        "agents/openai.yaml",
        "references/mail/1.0.0/deep/more.md",
        "references/mail/1.0.0/index.md",
        "references/plugins.md",
        "references/sign-in.md",
      ]);
      expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("untouched");
      expect((await readdir(target)).filter((name) => name.startsWith("."))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stores targets under the home directory with a tilde", () => {
    expect(normalizeSkillTarget("~/.agents/skills")).toBe("~/.agents/skills");
    expect(normalizeSkillTarget("/opt/skills")).toBe("/opt/skills");
    expect(normalizeSkillTarget(`${process.env.HOME}/x`)).toBe("~/x");
  });
});
