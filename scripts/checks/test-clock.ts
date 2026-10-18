import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { listFiles } from "./files";
import type { Finding, Rule } from "./rule";

const BASELINE = "scripts/checks/test-clock.baseline";
const testClockFiles = /\.(?:browser|behavior|render)\.test\.tsx?$|[.-]browser-(?:fixture|harness|suite)\.tsx?$|^browser-harness\.tsx?$/;
const message =
  "Use a fixed date (a fixture constant, bun:test setSystemTime, or a page init script that pins Date), performance.now() for durations, or // real clock: <reason>.";

/** Keep strings, including page scripts, but blank comments without changing positions or line numbers. */
export const checkTestClockSource = (file: string, source: string): Finding[] => {
  const optOuts = new Set<number>();
  const code = source.replace(
    /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    (token, offset: number) => {
      if (!token.startsWith("//") && !token.startsWith("/*")) return token;
      if (/^\/\/[ \t]*real clock:[ \t]*\S/.test(token)) optOuts.add(source.slice(0, offset).split("\n").length);
      return token.replace(/[^\r\n]/g, " ");
    },
  );
  return [...code.matchAll(/\bnew\s+Date\s*\(\s*\)|\bDate\s*\.\s*now\s*\(\s*\)/g)].flatMap((match) => {
    const line = code.slice(0, match.index).split("\n").length;
    return optOuts.has(line) || optOuts.has(line - 1) ? [] : [{ file, line, message }];
  });
};

export const collectTestClockFindings = (workspaceRoot: string): Finding[] =>
  ["packages", "pwas", "docs-site/src"]
    .flatMap((root) => listFiles(join(workspaceRoot, root), testClockFiles))
    .sort()
    .flatMap((file) => checkTestClockSource(relative(workspaceRoot, file), readFileSync(file, "utf8")));

const BASELINE_HEADER = [
  "# Known test-clock findings, one per file: <file> | <count>.",
  "# Migrations lower counts and remove entries; the rule never raises counts or adds lines.",
  "# `bun scripts/check.ts test-clock --fix` lowers counts whose findings are gone.",
];
export const formatBaseline = (counts: ReadonlyMap<string, number>): string =>
  `${[...BASELINE_HEADER, ...[...counts].map(([file, count]) => `${file} | ${count}`).sort()].join("\n")}\n`;

const readBaseline = (path: string): Map<string, number> => {
  const counts = new Map<string, number>();
  if (!existsSync(path)) return counts;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const match = /^(.+) \| ([1-9]\d*)$/.exec(line);
    if (!match) throw new Error(`Invalid test-clock baseline entry: ${line}`);
    counts.set(match[1]!, Number(match[2]));
  }
  return counts;
};

export const rule: Rule = {
  name: "test-clock",
  description: "UI tests pin the clock instead of reading today's date",
  run: async ({ workspaceRoot, fix }) => {
    const baselinePath = join(workspaceRoot, BASELINE);
    const baseline = readBaseline(baselinePath);
    const byFile = new Map<string, Finding[]>();
    for (const finding of collectTestClockFindings(workspaceRoot)) {
      const file = finding.file!;
      const entries = byFile.get(file) ?? [];
      entries.push(finding);
      byFile.set(file, entries);
    }
    const failures: Finding[] = [];
    for (const [file, findings] of byFile) {
      if (findings.length > (baseline.get(file) ?? 0))
        failures.push(...findings.map((finding) => ({ ...finding, file: join(workspaceRoot, file) })));
    }
    let lowered = false;
    for (const [file, count] of baseline) {
      const actual = byFile.get(file)?.length ?? 0;
      if (actual >= count) continue;
      if (fix) {
        if (actual === 0) baseline.delete(file);
        else baseline.set(file, actual);
        lowered = true;
      } else {
        failures.push({
          file: baselinePath,
          message: `${file} has ${actual} finding(s), below its baseline of ${count}; lower/remove the entry (bun scripts/check.ts test-clock --fix).`,
        });
      }
    }
    if (lowered) writeFileSync(baselinePath, formatBaseline(baseline));
    return failures;
  },
};
