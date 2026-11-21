import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./rule";

/**
 * A known finding of a rule with a baseline. The key names the file and what was found, never a line number, so a
 * lane that edits a file elsewhere keeps its entry, and several lanes can shrink one baseline in parallel.
 */
export type KeyedFinding = Finding & { file: string; key: string };

const entries = (path: string): string[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
    : [];

/** The baseline file: the header as comments, then one sorted line per known finding. */
export const formatBaseline = (header: readonly string[], keys: readonly string[]): string =>
  `${[...header.map((line) => `# ${line}`), ...[...keys].sort()].join("\n")}\n`;

/**
 * Compares findings with `scripts/checks/<rule>.baseline`: one sorted line per known finding, repeated for each
 * occurrence. A finding beyond the baseline fails. A baseline line whose finding is gone fails too, so the baseline only
 * shrinks; `--fix` rewrites the file to what is still found (it never adds a line that was not there).
 */
export const compareBaseline = (
  workspaceRoot: string,
  rule: string,
  header: readonly string[],
  findings: readonly KeyedFinding[],
  fix: boolean,
): Finding[] => {
  const relativePath = `scripts/checks/${rule}.baseline`;
  const path = join(workspaceRoot, relativePath);
  const remaining = new Map<string, number>();
  for (const key of entries(path)) remaining.set(key, (remaining.get(key) ?? 0) + 1);
  const known: string[] = [];
  const failures: Finding[] = [];
  for (const finding of findings) {
    const count = remaining.get(finding.key) ?? 0;
    if (count > 0) {
      remaining.set(finding.key, count - 1);
      known.push(finding.key);
    } else failures.push({ file: finding.file, line: finding.line, message: finding.message });
  }
  const stale = [...remaining].flatMap(([key, count]) => Array<string>(count).fill(key));
  if (stale.length > 0 && fix) writeFileSync(path, formatBaseline(header, known));
  else
    for (const key of stale)
      failures.push({ file: path, message: `Fixed: remove “${key}” from ${relativePath} (bun scripts/check.ts ${rule} --fix).` });
  return failures;
};
