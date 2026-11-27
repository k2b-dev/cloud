import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isDirectory, isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * `CREATE INDEX CONCURRENTLY` waits for every older snapshot, so a long transaction (a nightly dump) holds it for hours.
 * Awaited at startup, it holds the app's start, and a restart during the build can loop. Every build goes through
 * `packages/cloud/src/services/concurrent-index.ts`, which starts after the migration without being awaited, holds a
 * lease per table across replicas, replaces interrupted builds and never throws.
 */
const HELPER = "packages/cloud/src/services/concurrent-index.ts";

/**
 * Builds that predate the helper, each with its reason. An entry leaves when its file moves to the helper; an entry
 * whose file no longer builds concurrently is reported, so the list only shrinks.
 */
export const ALLOWED: Record<string, string> = {
  "packages/grids/src/service/field-indexes.ts": "per-field indexes a person adds at runtime, not at startup",
  "packages/mail/src/migrate.ts": "Mail's startup indexes; moving them is Mail's own change",
  "packages/mail/src/migrate-reply-drafts.ts": "Mail's startup indexes; moving them is Mail's own change",
  "packages/mail/src/service/room-access-events.ts": "Mail's startup indexes; moving them is Mail's own change",
};

const BUILD = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/g;

/** Every concurrent index build in one source, with its line. */
export const concurrentBuilds = (source: string): number[] => {
  const lines: number[] = [];
  for (const match of source.matchAll(BUILD)) lines.push(source.slice(0, match.index).split("\n").length);
  return lines;
};

export const rule: Rule = {
  name: "concurrent-index-builds",
  description: "CREATE INDEX CONCURRENTLY runs only through the background helper, never awaited at startup",
  run: async ({ workspaceRoot }) => {
    const packages = join(workspaceRoot, "packages");
    if (!isDirectory(packages)) return [];
    const findings: Finding[] = [];
    const used = new Set<string>();
    for (const entry of readdirSync(packages, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const path of listFiles(join(packages, entry.name, "src"), sourceFilePattern)) {
        if (isTestFile(path)) continue;
        const file = relative(workspaceRoot, path);
        const lines = concurrentBuilds(readFileSync(path, "utf8"));
        if (lines.length === 0 || file === HELPER) continue;
        if (ALLOWED[file]) {
          used.add(file);
          continue;
        }
        for (const line of lines)
          findings.push({
            file,
            line,
            message: `CREATE INDEX CONCURRENTLY outside ${HELPER}; use buildConcurrentIndexesInBackground after the migration (startup must not wait for it)`,
          });
      }
    }
    for (const file of Object.keys(ALLOWED))
      if (!used.has(file))
        findings.push({ file, message: "builds no index concurrently any more; remove it from ALLOWED in concurrent-index-builds.ts" });
    return findings;
  },
};
