import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_SKILL_FILES } from "./skill-source";
import { normalizeSkillTarget, referenceFolder, renderSkill, syncSkillTargets, writeSkillTarget } from "./skills";

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
      { profile: "work", name: "mail", version: "0.19.0", digest: "d1" },
      { profile: "home", name: "notebooks", version: "0.18.2", digest: "d2" },
    ]);
    expect(rendered).toContain("| home | notebooks | 0.18.2 | `references/notebooks/0.18.2/` |");
    expect(rendered).toContain("| work | mail | 0.19.0 | `references/mail/0.19.0/` |");
    expect(rendered).not.toContain("PLACEHOLDER");
    expect(rendered.startsWith("# Skill\n\n<!-- cld:modules -->\n")).toBe(true);
    expect(rendered.endsWith("<!-- /cld:modules -->\n\nTail\n")).toBe(true);
    expect(() => renderSkill("# no block", [])).toThrow("cld:modules");
    expect(referenceFolder("grids", "1.0.0+build/7")).toBe("references/grids/1.0.0_build_7/");
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
        { profile: "a", name: "mail", version: "1.0.0", digest: "a".repeat(128) },
        { profile: "b", name: "mail", version: "1.0.0", digest: "a".repeat(128) },
        { profile: "b", name: "mail", version: "2.0.0", digest: "b".repeat(128) },
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
      expect(await readFile(join(written, "SKILL.md"), "utf8")).toContain("| b | mail | 2.0.0 | `references/mail/2.0.0/` |");

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
