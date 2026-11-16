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
 * These shapes escape them and are flagged:
 *
 * - a raw `setInterval(` (also `globalThis.setInterval(`), a self-scheduling
 *   `setTimeout` loop (a function that passes itself to `setTimeout`), and
 *   `superviseRuntimeTask(` in server code. One that must keep running while
 *   quiet (a lease heartbeat of work in flight, a live connection or watcher,
 *   a timer whose callback already goes through a tracker) carries
 *   `// runtime-timer: <reason>` on the line above;
 * - `createSync(` outside the process Sync: its workers would not follow
 *   quiesce.
 *
 * Server code is `.ts`; `.tsx` files render UI and their timers run in the
 * browser. Browser code, tests, and the packages that never quiesce (the
 * standalone libraries, the gateway, and the `cld` terminal client) are out
 * of scope.
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
const timerCall = /(?:(?<![.\w])|(?<![\w$])globalThis\.)(?:setInterval|superviseRuntimeTask)\(/;
/** `setTimeout(name` or `setTimeout(() => name(` / `setTimeout(() => void name(`: the callback's name. */
const timeoutCallback = /(?<![.\w])setTimeout\(\s*(?:\(\)\s*=>\s*(?:void\s+)?)?([A-Za-z_$][\w$]*)\s*[,(]/;
const createSyncCall = /(?<![.\w])createSync\(/;

const isComment = (line: string): boolean => /^\s*(?:\/\/|\/\*|\*)/.test(line);

/** Has a `// runtime-timer: <reason>` on the same line or the line above. */
const marked = (lines: readonly string[], index: number): boolean =>
  [lines[index], lines[index - 1]].some((line) => (line?.match(MARKER)?.[1]?.trim().length ?? 0) >= MIN_REASON_LENGTH);

/**
 * Whether line `index` lies inside the body of a function named `name` that
 * is declared above it (`function name`, `const name =`, `let name =`) and
 * opens its body on that line. Braces are counted from the declaration;
 * braces in strings can confuse it, which only costs a marker.
 */
const insideOwnBody = (lines: readonly string[], index: number, name: string): boolean => {
  const declaration = new RegExp(`(?:function\\s+${name}\\b|(?:const|let)\\s+${name}\\s*=)`);
  for (let start = index; start >= 0; start -= 1) {
    if (!declaration.test(lines[start] ?? "")) continue;
    // A body opens on its declaration line; a one-line arrow without braces never loops.
    if (!lines[start]?.includes("{")) return false;
    let depth = 0;
    let opened = false;
    for (let at = start; at <= index; at += 1) {
      const line = lines[at] ?? "";
      for (const char of at === index ? line.slice(0, line.search(/setTimeout\(/)) : line) {
        if (char === "{") {
          depth += 1;
          opened = true;
        } else if (char === "}") depth -= 1;
      }
      if (opened && depth <= 0 && at < index) return false;
    }
    return opened && depth > 0;
  }
  return false;
};

/** 1-based lines of unmarked timers, self-scheduling loops and supervised tasks, and of `createSync(` calls in `source`. */
export const backgroundWorkFindings = (source: string, { allowCreateSync = false } = {}): { line: number; kind: "timer" | "sync" }[] => {
  const lines = source.split("\n");
  const found: { line: number; kind: "timer" | "sync" }[] = [];
  for (const [index, line] of lines.entries()) {
    if (isComment(line)) continue;
    const callback = line.match(timeoutCallback)?.[1];
    const loop = callback !== undefined && insideOwnBody(lines, index, callback);
    if ((timerCall.test(line) || loop) && !marked(lines, index)) found.push({ line: index + 1, kind: "timer" });
    if (!allowCreateSync && createSyncCall.test(line)) found.push({ line: index + 1, kind: "sync" });
  }
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
      if (!["setInterval(", "setTimeout(", "superviseRuntimeTask(", "createSync("].some((call) => source.includes(call))) continue;
      for (const { line, kind } of backgroundWorkFindings(source, { allowCreateSync: CREATE_SYNC_ALLOWED.has(path) })) {
        findings.push({
          file,
          line,
          message:
            kind === "timer"
              ? "start periodic background work with startRuntimeInterval() or run it through createRuntimeTaskTracker(), so maintenance quiesce stops it; a timer, loop or supervised task that must keep running carries `// runtime-timer: <reason>` on the line above"
              : "declare Sync primitives on the process Sync (lazySync, app.sync); workers of another Sync instance do not follow maintenance quiesce",
        });
      }
    }
    return findings;
  },
};
