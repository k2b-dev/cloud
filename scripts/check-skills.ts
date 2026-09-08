import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

type Violation = {
  file: string;
  message: string;
};

const workspaceRoot = join(import.meta.dir, "..");
const skillsRoot = join(workspaceRoot, "skills");
const publishedSkillsRoot = join(workspaceRoot, "docs-site", "agent-skills");
const publishedEvalsRoot = join(workspaceRoot, "docs-site", "evals");

const expectedSkills = ["cloud-cli"] as const;

/** Keep repository skills as compact routers to their bundled references. */
const MAX_SKILL_LINES = 260;
const MAX_PUBLISHED_SKILL_LINES = 180;

/** Paths in documentation examples that intentionally do not exist on disk. */
const isPlaceholderPath = (path: string): boolean => /^packages\/(?:my-app|inventory)(?:\/|$)/.test(path) || path.startsWith("packages/<");

const isDirectory = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

const parseFrontmatter = (source: string): Record<string, string> | null => {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return null;

  const fields: Record<string, string> = {};
  const lines = match[1].split("\n");
  let currentKey: string | null = null;
  let currentValue = "";

  for (const rawLine of lines) {
    // Indented line → continuation of previous block scalar value
    if (currentKey && /^\s{2,}/.test(rawLine)) {
      currentValue += ` ${rawLine.trim()}`;
      continue;
    }

    // Flush previous key
    if (currentKey) {
      fields[currentKey] = currentValue.trim();
      currentKey = null;
      currentValue = "";
    }

    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();

    // Block scalar indicator (> or |)
    if (value === ">" || value === "|") {
      currentKey = key;
      currentValue = "";
    } else {
      fields[key] = value;
    }
  }

  // Flush last key
  if (currentKey) {
    fields[currentKey] = currentValue.trim();
  }

  return fields;
};

/**
 * Reference file names a document points at. Both link styles are in use:
 * a backticked bare name (`backend.md`) and a markdown link that may carry a
 * directory prefix ([Account](references/account.md)).
 */
const referencedDocs = (source: string): string[] => {
  const names = new Set<string>();
  for (const match of source.matchAll(/[`(](?:\.?\/?references\/)?([a-z0-9-]+\.md)[`)]/g)) {
    names.add(match[1]);
  }
  return [...names];
};

/** Repo-relative packages/* paths cited as evidence in a document. */
const citedRepoPaths = (source: string): string[] => {
  const paths = new Set<string>();
  for (const match of source.matchAll(/packages\/[a-zA-Z0-9._/-]+/g)) {
    paths.add(match[0].replace(/[.,)`]+$/, ""));
  }
  return [...paths];
};

const violations: Violation[] = [];

const validateEvals = (file: string, skillName: string, requireExpectations = false): void => {
  if (!existsSync(file)) {
    violations.push({ file, message: `Missing evaluation cases for '${skillName}'.` });
    return;
  }

  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      skill_name?: unknown;
      evals?: unknown;
    };
    const evals = Array.isArray(parsed.evals) ? parsed.evals : [];
    const ids = new Set<number>();
    const validEvals = evals.every((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const { id, prompt, expected_output: expectedOutput, files, expectations } = entry as Record<string, unknown>;
      if (!Number.isInteger(id) || (id as number) < 1 || ids.has(id as number)) return false;
      ids.add(id as number);
      const validExpectations =
        !requireExpectations ||
        (Array.isArray(expectations) &&
          expectations.length > 0 &&
          expectations.every((expectation) => typeof expectation === "string" && expectation.trim().length > 0));
      const validFiles = !requireExpectations || (Array.isArray(files) && files.every((file) => typeof file === "string"));
      return (
        typeof prompt === "string" &&
        prompt.trim().length > 0 &&
        typeof expectedOutput === "string" &&
        expectedOutput.trim().length > 0 &&
        validFiles &&
        validExpectations
      );
    });

    if (parsed.skill_name !== skillName || evals.length < 6 || !validEvals) {
      violations.push({
        file,
        message: `Expected '${skillName}' with at least six valid evaluation cases and unique positive ids.`,
      });
    }
  } catch {
    violations.push({ file, message: "Evaluation file must contain valid JSON." });
  }
};

if (!isDirectory(skillsRoot)) {
  console.error("Missing skills directory at cloud/skills.");
  process.exit(1);
}

const actualSkills = readdirSync(skillsRoot)
  .filter((entry) => entry !== "old_skills" && isDirectory(join(skillsRoot, entry)))
  .sort();

for (const expected of expectedSkills) {
  if (!actualSkills.includes(expected)) {
    violations.push({
      file: join(skillsRoot, expected),
      message: "Expected skill folder is missing.",
    });
  }
}

for (const actual of actualSkills) {
  if (!expectedSkills.includes(actual as (typeof expectedSkills)[number])) {
    violations.push({
      file: join(skillsRoot, actual),
      message: "Unexpected skill folder found (skill set is strict).",
    });
  }
}

for (const skill of expectedSkills) {
  const skillDir = join(skillsRoot, skill);
  if (!isDirectory(skillDir)) continue;

  const skillMd = join(skillDir, "SKILL.md");
  if (!existsSync(skillMd)) {
    violations.push({ file: skillMd, message: "Missing SKILL.md." });
    continue;
  }

  const skillSource = readFileSync(skillMd, "utf8");
  const fields = parseFrontmatter(skillSource);
  if (!fields) {
    violations.push({
      file: skillMd,
      message: "SKILL.md must start with YAML frontmatter delimited by ---.",
    });
  } else {
    const keys = Object.keys(fields).sort();
    if (keys.join(",") !== "description,name") {
      violations.push({
        file: skillMd,
        message: "Frontmatter must contain only 'name' and 'description'.",
      });
    }

    if (fields.name !== skill) {
      violations.push({
        file: skillMd,
        message: `Frontmatter name must equal folder name ('${skill}').`,
      });
    }

    if (!fields.description || fields.description.length < 20) {
      violations.push({
        file: skillMd,
        message: "Frontmatter description is missing or too short.",
      });
    }
  }

  const body = skillSource.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  if (body.length === 0) {
    violations.push({
      file: skillMd,
      message: "SKILL.md body must not be empty.",
    });
  }

  const skillLines = skillSource.split("\n").length;
  if (skillLines > MAX_SKILL_LINES) {
    violations.push({
      file: skillMd,
      message: `SKILL.md is ${skillLines} lines (max ${MAX_SKILL_LINES}). It routes to references; move detail into one.`,
    });
  }

  const referencesDir = join(skillDir, "references");
  if (!isDirectory(referencesDir)) {
    violations.push({
      file: referencesDir,
      message: "Missing references directory.",
    });
    continue;
  }

  const referenceFiles = readdirSync(referencesDir).filter(
    (entry) => entry.endsWith(".md") && statSync(join(referencesDir, entry)).isFile(),
  );
  if (referenceFiles.length === 0) {
    violations.push({
      file: referencesDir,
      message: "references directory must contain at least one file.",
    });
    continue;
  }

  const docs = new Map<string, string>([["SKILL.md", skillSource]]);
  for (const entry of referenceFiles) {
    const source = readFileSync(join(referencesDir, entry), "utf8");
    docs.set(entry, source);
  }

  // Every reference must be reachable from SKILL.md. Multi-hop is fine — a
  // reference may legitimately be linked only from another reference.
  const reachable = new Set<string>();
  const queue = ["SKILL.md"];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const name of referencedDocs(docs.get(current) ?? "")) {
      if (!docs.has(name) || reachable.has(name)) continue;
      reachable.add(name);
      queue.push(name);
    }
  }

  for (const entry of referenceFiles) {
    if (!reachable.has(entry)) {
      violations.push({
        file: join(referencesDir, entry),
        message: "Orphan reference: not reachable from SKILL.md. Link it or delete it.",
      });
    }
  }

  for (const [name, source] of docs) {
    const file = name === "SKILL.md" ? skillMd : join(referencesDir, name);

    for (const target of referencedDocs(source)) {
      // Ignore names that are not this skill's own references (e.g. *.help.md
      // examples in prose); only flag a miss that looks like a sibling doc.
      if (docs.has(target) || !/^[a-z-]+\.md$/.test(target)) continue;
      if (referenceFiles.includes(target)) continue;
      violations.push({
        file,
        message: `References '${target}', which does not exist in references/.`,
      });
    }

    for (const cited of citedRepoPaths(source)) {
      if (isPlaceholderPath(cited)) continue;
      if (existsSync(join(workspaceRoot, cited))) continue;
      violations.push({
        file,
        message: `Cites '${cited}', which does not exist. Fix or remove the path.`,
      });
    }
  }
}

if (!isDirectory(publishedSkillsRoot)) {
  violations.push({ file: publishedSkillsRoot, message: "Missing Fibel agent-skills directory." });
} else {
  const publishedSkills = readdirSync(publishedSkillsRoot)
    .filter((entry) => isDirectory(join(publishedSkillsRoot, entry)))
    .sort();

  if (publishedSkills.join(",") !== "cloud-dev") {
    violations.push({
      file: publishedSkillsRoot,
      message: "Fibel must publish exactly one developer skill named 'cloud-dev'.",
    });
  }

  const publishedSkillDir = join(publishedSkillsRoot, "cloud-dev");
  if (isDirectory(publishedSkillDir)) {
    const entries = readdirSync(publishedSkillDir).sort();
    if (entries.join(",") !== "SKILL.md") {
      violations.push({
        file: publishedSkillDir,
        message: "The Fibel skill must be self-contained and contain only SKILL.md.",
      });
    }

    const skillMd = join(publishedSkillDir, "SKILL.md");
    if (existsSync(skillMd)) {
      const source = readFileSync(skillMd, "utf8");
      const fields = parseFrontmatter(source);
      const frontmatterKeys = fields ? Object.keys(fields).sort().join(",") : "";
      if (
        !fields ||
        frontmatterKeys !== "description,name" ||
        fields.name !== "cloud-dev" ||
        !fields.description ||
        fields.description.length < 80 ||
        !/^description: >$/m.test(source)
      ) {
        violations.push({
          file: skillMd,
          message: "Published skill needs valid cloud-dev frontmatter and a useful description.",
        });
      }

      const lineCount = source.split("\n").length;
      if (lineCount > MAX_PUBLISHED_SKILL_LINES) {
        violations.push({
          file: skillMd,
          message: `Published skill is ${lineCount} lines (max ${MAX_PUBLISHED_SKILL_LINES}); detailed knowledge belongs in Fibel.`,
        });
      }

      if (/\]\((?:\.\/)?references\//.test(source)) {
        violations.push({
          file: skillMd,
          message: "Published skill must not depend on bundled references; use the Fibel MCP.",
        });
      }

      for (const required of [
        "cloud-dev-mcp",
        "https://cloud.k2b.dev/_fibel/mcp",
        "list_collections",
        "search_docs",
        "read_doc",
        "actor",
        "accessSubject",
        "@k2b/stdlib",
        "@k2b/ssr",
        "@k2b/sync",
        "@k2b/ui",
        "@k2b/cloud/workflows",
      ]) {
        if (!source.includes(required)) {
          violations.push({ file: skillMd, message: `Published skill is missing required guidance: '${required}'.` });
        }
      }
    }
  }
}

validateEvals(join(publishedEvalsRoot, "cloud-dev", "evals.json"), "cloud-dev", true);

if (violations.length > 0) {
  console.error("Skills check failed:\n");
  for (const violation of violations) {
    console.error(`- ${relative(workspaceRoot, violation.file)} ${violation.message}`);
  }
  process.exit(1);
}

console.log("Skills check passed (cloud-cli repository skill, cloud-dev Fibel skill).");
