import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isDirectory, isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * A concurrent index statement (`CREATE INDEX CONCURRENTLY`, `REINDEX … CONCURRENTLY`, `DROP INDEX CONCURRENTLY`) waits
 * for every older snapshot or lock holder, so a long transaction (a nightly dump) holds it for hours. Awaited at
 * startup, it holds the app's start, and a restart during the build can loop. Every one goes through
 * `packages/cloud/src/services/concurrent-index.ts`, which starts after the migration without being awaited, holds a
 * lease per table across replicas, replaces interrupted builds and never throws.
 */
const HELPER = "packages/cloud/src/services/concurrent-index.ts";
const SELF = "scripts/checks/concurrent-index-builds.ts";

/**
 * Statements that predate the helper, each with its reason. An entry leaves when its file moves to the helper; an entry
 * whose file no longer has one is reported, so the list only shrinks.
 */
export const ALLOWED: Record<string, string> = {
  "packages/grids/src/service/field-indexes.ts": "per-field indexes a person adds at runtime, not at startup",
  "packages/mail/src/migrate.ts": "Mail's startup indexes; they move onto the helper in #4491",
  "packages/mail/src/migrate-reply-drafts.ts": "Mail's startup indexes, one of them UNIQUE; they move in #4491",
  "packages/mail/src/service/room-access-events.ts": "Mail's startup indexes; they move onto the helper in #4491",
};

// Also `CREATE ${unique}INDEX` and lower case; REINDEX's object may stand between it and CONCURRENTLY.
const STATEMENT = /(?:CREATE\s+(?:UNIQUE\s+|\$\{[^}]*\}\s*)?INDEX|REINDEX\b[^;`]*?|DROP\s+INDEX)\s+CONCURRENTLY/gi;

/** Every concurrent index statement in one source, with its line. */
export const concurrentBuilds = (source: string): number[] => {
  const lines: number[] = [];
  for (const match of source.matchAll(STATEMENT)) lines.push(source.slice(0, match.index).split("\n").length);
  return lines;
};

const MESSAGE =
  `concurrent index statement outside ${HELPER}. An index queries only run faster with: ` +
  "buildConcurrentIndexesInBackground after the migration, never awaited at startup. " +
  "A UNIQUE index a transaction relies on is not one of those: create it in the migration before its first use (createIndexIfMissing with unique)";

export const rule: Rule = {
  name: "concurrent-index-builds",
  description: "Concurrent index statements run only through the background helper, never awaited at startup",
  run: async ({ workspaceRoot }) => {
    const roots: string[] = [join(workspaceRoot, "scripts")];
    const packages = join(workspaceRoot, "packages");
    if (isDirectory(packages))
      for (const entry of readdirSync(packages, { withFileTypes: true }))
        if (entry.isDirectory()) roots.push(join(packages, entry.name, "src"));
    const findings: Finding[] = [];
    const used = new Set<string>();
    for (const root of roots) {
      for (const path of listFiles(root, sourceFilePattern)) {
        if (isTestFile(path)) continue;
        const file = relative(workspaceRoot, path);
        if (file === HELPER || file === SELF) continue;
        const lines = concurrentBuilds(readFileSync(path, "utf8"));
        if (lines.length === 0) continue;
        if (ALLOWED[file]) {
          used.add(file);
          continue;
        }
        for (const line of lines) findings.push({ file, line, message: MESSAGE });
      }
    }
    for (const file of Object.keys(ALLOWED))
      if (!used.has(file))
        findings.push({
          file,
          message: "has no concurrent index statement any more; remove it from ALLOWED in concurrent-index-builds.ts",
        });
    return findings;
  },
};
