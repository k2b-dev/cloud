import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isDirectory, isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * Postgres takes the table lock of `ADD COLUMN IF NOT EXISTS` (ACCESS EXCLUSIVE) and `CREATE INDEX IF NOT EXISTS`
 * (SHARE) before it checks whether the object exists. At startup such a statement waits behind a dump, an index build
 * or a long transaction, and every query of the table queues behind it. Migrations use `addColumns` and
 * `createIndexes` from `packages/cloud/src/services/migration-ddl.ts`, which read the catalog first and bound the wait.
 */
const HELPER = "packages/cloud/src/services/migration-ddl.ts";
export const BASELINE = "scripts/checks/startup-ddl-locks.baseline";
const STATEMENT = /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS|CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS/gi;
const header = [
  "# Startup DDL that locks a table even when nothing changes, per file: <count> <file>.",
  "# A file may only lose statements: move them to addColumns/createIndexes (@k2b/cloud/services/migration-ddl).",
  "# `bun scripts/check.ts startup-ddl-locks --fix` lowers or removes entries; it never raises one.",
];

/** Lines of every unconditional locking DDL statement in one source. */
export const lockingStatements = (source: string): number[] =>
  [...source.matchAll(STATEMENT)].map((match) => source.slice(0, match.index).split("\n").length);

const readBaseline = (path: string): Map<string, number> => {
  const baseline = new Map<string, number>();
  if (!existsSync(path)) return baseline;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const match = /^(\d+) (\S+)$/.exec(line);
    if (!match) throw new Error(`Invalid startup-ddl-locks baseline entry: ${line}`);
    baseline.set(match[2]!, Number(match[1]));
  }
  return baseline;
};

const writeBaseline = (path: string, baseline: ReadonlyMap<string, number>) =>
  writeFileSync(
    path,
    `${[
      ...header,
      ...[...baseline]
        .filter(([, count]) => count > 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([file, count]) => `${count} ${file}`),
    ].join("\n")}\n`,
  );

export const rule: Rule = {
  name: "startup-ddl-locks",
  description: "Startup migrations add columns and indexes through the catalog-first helpers, not IF NOT EXISTS DDL",
  run: async ({ workspaceRoot, fix }) => {
    const packages = join(workspaceRoot, "packages");
    if (!isDirectory(packages)) return [];
    const baselinePath = join(workspaceRoot, BASELINE);
    const baseline = readBaseline(baselinePath);
    const counts = new Map<string, number[]>();
    for (const entry of readdirSync(packages, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const path of listFiles(join(packages, entry.name, "src"), sourceFilePattern)) {
        const file = relative(workspaceRoot, path);
        if (isTestFile(path) || file === HELPER) continue;
        const lines = lockingStatements(readFileSync(path, "utf8"));
        if (lines.length > 0) counts.set(file, lines);
      }
    }
    const findings: Finding[] = [];
    const lowered = new Map(baseline);
    for (const [file, lines] of counts) {
      const allowed = baseline.get(file) ?? 0;
      if (lines.length > allowed) {
        findings.push({
          file,
          line: lines[allowed],
          message: `${lines.length} IF NOT EXISTS column or index statements, ${allowed} allowed; use addColumns or createIndexes from @k2b/cloud/services/migration-ddl`,
        });
      }
    }
    for (const [file, allowed] of baseline) {
      const count = counts.get(file)?.length ?? 0;
      if (count >= allowed) continue;
      lowered.set(file, count);
      if (!fix) findings.push({ file, message: `has ${count} of ${allowed} allowed statements; lower its entry in ${BASELINE} (--fix)` });
    }
    if (fix && [...lowered].some(([file, count]) => baseline.get(file) !== count)) writeBaseline(baselinePath, lowered);
    return findings;
  },
};
