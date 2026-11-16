import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { workspacePackages } from "../workspace";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * Background work in Cloud server code starts through platform mechanisms,
 * so maintenance stage „Ruhe“ (quiesce) reaches it without the application
 * opting in: Sync workers of the process Sync, `createRuntimeTaskTracker()`,
 * `createRuntimeLifecycle()`, and `startRuntimeInterval()`.
 *
 * Two shapes escape them and are flagged:
 *
 * - a raw `setInterval(` in server code. A timer that must keep running while
 *   quiet (a lease heartbeat of work in flight, a live connection, a timer
 *   whose callback already goes through a tracker) carries
 *   `// runtime-timer: <reason>` on the line above;
 * - `createSync(` outside the process Sync: its workers would not follow
 *   quiesce.
 *
 * Browser code, tests, and the packages that never quiesce (the standalone
 * libraries, the gateway, and the `cld` terminal client) are out of scope.
 */

const EXCLUDED_PACKAGES = new Set(["packages/ui", "packages/ssr", "packages/editor", "packages/gateway", "packages/cloud-cli"]);
const BROWSER_PATH = /\/(?:frontend|browser|client|test|tests)\//;

/** `createSync(` call sites that are not application runtime, each with its reason. */
const CREATE_SYNC_ALLOWED = new Map<string, string>([
  ["packages/cloud/src/_internal/process-sync.ts", "creates the process Sync, which applies quiesce"],
  ["packages/grids/src/sync-test-utils.ts", "test helper on an isolated test namespace"],
  ["packages/grids/src/service/document-workflow-crash.worker.ts", "crash-test child process of an integration test"],
]);

const MARKER = /\/\/\s*runtime-timer:\s*(.*)$/;
const MIN_REASON_LENGTH = 8;
const setIntervalCall = /(?<![.\w])setInterval\(/;
const createSyncCall = /(?<![.\w])createSync\(/;

const isComment = (line: string): boolean => /^\s*(?:\/\/|\/\*|\*)/.test(line);

/** Has a `// runtime-timer: <reason>` on the same line or the line above. */
const marked = (lines: readonly string[], index: number): boolean =>
  [lines[index], lines[index - 1]].some((line) => (line?.match(MARKER)?.[1]?.trim().length ?? 0) >= MIN_REASON_LENGTH);

/** 1-based lines of unmarked `setInterval(` and of `createSync(` calls in `source`. */
export const backgroundWorkFindings = (source: string, { allowCreateSync = false } = {}): { line: number; kind: "timer" | "sync" }[] => {
  const lines = source.split("\n");
  const found: { line: number; kind: "timer" | "sync" }[] = [];
  lines.forEach((line, index) => {
    if (isComment(line)) return;
    if (setIntervalCall.test(line) && !marked(lines, index)) found.push({ line: index + 1, kind: "timer" });
    if (!allowCreateSync && createSyncCall.test(line)) found.push({ line: index + 1, kind: "sync" });
  });
  return found;
};

const inScope = (path: string): boolean =>
  /\.ts$/.test(path) && !isTestFile(path) && !BROWSER_PATH.test(path) && !/\.browser-harness\./.test(path);

export const rule: Rule = {
  name: "background-work",
  description: "Server background work starts through platform mechanisms, so maintenance quiesce reaches it",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    const roots = workspacePackages(workspaceRoot)
      .filter((path) => path.startsWith("packages/") && !EXCLUDED_PACKAGES.has(path))
      .map((path) => join(workspaceRoot, path, "src"));
    for (const file of roots.flatMap((root) => listFiles(root, /\.ts$/)).sort()) {
      const path = relative(workspaceRoot, file);
      if (!inScope(`/${path}`)) continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes("setInterval(") && !source.includes("createSync(")) continue;
      for (const { line, kind } of backgroundWorkFindings(source, { allowCreateSync: CREATE_SYNC_ALLOWED.has(path) })) {
        findings.push({
          file,
          line,
          message:
            kind === "timer"
              ? "start periodic background work with startRuntimeInterval() or run it through createRuntimeTaskTracker(), so maintenance quiesce stops it; a timer that must keep running carries `// runtime-timer: <reason>` on the line above"
              : "declare Sync primitives on the process Sync (lazySync, app.sync); workers of another Sync instance do not follow maintenance quiesce",
        });
      }
    }
    return findings;
  },
};
