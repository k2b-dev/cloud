import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { workspacePackages } from "../workspace";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

/** Every regular-expression metacharacter escaped, so a function name matches only itself. */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Background work in Cloud server code starts through platform mechanisms,
 * so maintenance stage „Ruhe“ (quiesce) reaches it without the application
 * opting in: Sync workers of the process Sync, `createRuntimeTaskTracker()`,
 * `createRuntimeLifecycle()`, and `startRuntimeInterval()`.
 *
 * These shapes escape them and are flagged:
 *
 * - a raw `setInterval(` (also `globalThis.setInterval(`), a self-scheduling
 *   `setTimeout` loop (also `globalThis.setTimeout`: the timeout's arguments
 *   name a function whose declaration encloses it, directly, in a block or
 *   async callback, or chained as in `.finally(schedule)`), and
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
const timerCall = /(?:(?<![.\w$])|(?<![\w$])globalThis\.)(?:setInterval|superviseRuntimeTask)\(/g;
const timeoutCall = /(?:(?<![.\w$])|(?<![\w$])globalThis\.)setTimeout\(/g;
const createSyncCall = /(?<![.\w$])createSync\(/g;
const IDENTIFIER = "[A-Za-z_$][\\w$]*";
/** `function name(`, `const name = (…) =>`, `const name = async x =>`, `let name = function`. */
const declaration = new RegExp(
  `(?<![\\w$])(?:function\\s*\\*?\\s*(${IDENTIFIER})\\s*[(<]|(?:const|let|var)\\s+(${IDENTIFIER})\\s*(?::[^=;]+)?=\\s*(?:async\\b\\s*)?(?:function\\b|\\(|<|${IDENTIFIER}\\s*=>))`,
  "g",
);
/** A class or object method: `name(…) {`, `private async name(…): T {` at the start of a line. */
const method = new RegExp(
  `^[ \\t]*(?:(?:private|protected|public|static|async|override|readonly)\\s+)*(${IDENTIFIER})\\s*(?:<[^>]*>)?\\(`,
  "gm",
);
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "await", "typeof", "new", "super", "else", "do"]);
/** A line that ends like this continues the statement on the next line. */
const CONTINUES = /(?:=>|[=(,?:&|+[{]|\?\?)\s*$/;

/**
 * `source` with comments, strings, template literals and regular expressions blanked out (newlines and
 * offsets kept), so the scan below sees only code. Template substitutions are blanked too; good enough
 * for a heuristic.
 */
export const codeOnly = (source: string): string => {
  const out = source.split("");
  const blank = (from: number, to: number) => {
    for (let at = from; at < to; at += 1) if (out[at] !== "\n") out[at] = " ";
  };
  let lastCode = "";
  for (let at = 0; at < source.length; ) {
    const char = source[at] ?? "";
    const next = source[at + 1] ?? "";
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", at);
      const stop = end === -1 ? source.length : end;
      blank(at, stop);
      at = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", at + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(at, stop);
      at = stop;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      let end = at + 1;
      while (end < source.length && source[end] !== char) {
        if (source[end] === "\\") end += 1;
        else if (char !== "`" && source[end] === "\n") break;
        end += 1;
      }
      blank(at + 1, end);
      at = end + 1;
      lastCode = char;
      continue;
    }
    if (char === "/" && (lastCode === "" || "(,=:[!&|?{};".includes(lastCode))) {
      let end = at + 1;
      let inClass = false;
      while (end < source.length && source[end] !== "\n" && (inClass || source[end] !== "/")) {
        if (source[end] === "\\") end += 1;
        else if (source[end] === "[") inClass = true;
        else if (source[end] === "]") inClass = false;
        end += 1;
      }
      blank(at + 1, end);
      at = end + 1;
      lastCode = "/";
      continue;
    }
    if (!/\s/.test(char)) lastCode = char;
    at += 1;
  }
  return out.join("");
};

/**
 * Where the statement that starts at `from` (a function declaration) ends: at the first point where
 * its brackets are balanced again and the line goes on with nothing that continues it (`;`, `,`, a
 * closing bracket, or the end of a line that does not continue).
 */
const statementEnd = (code: string, from: number): number => {
  let depth = 0;
  let opened = false;
  for (let at = from; at < code.length; at += 1) {
    const char = code[at];
    if (char === "(" || char === "{" || char === "[") {
      depth += 1;
      opened = true;
    } else if (char === ")" || char === "}" || char === "]") {
      depth -= 1;
      if (depth < 0) return at;
      if (depth === 0 && opened) {
        const lineEnd = code.indexOf("\n", at);
        const rest = code.slice(at + 1, lineEnd === -1 ? code.length : lineEnd).trim();
        if (rest === "" || /^[;,)\]}]/.test(rest)) {
          if (rest !== "" || !CONTINUES.test(code.slice(code.lastIndexOf("\n", at) + 1, at + 1))) return at;
        }
      }
    } else if (char === "\n" && depth === 0 && opened) {
      const line = code.slice(code.lastIndexOf("\n", at - 1) + 1, at);
      if (!CONTINUES.test(line)) return at;
    }
  }
  return code.length;
};

/** Named functions of `code` with the range of their declaration. */
const functionSpans = (code: string): { name: string; start: number; end: number }[] => {
  const spans: { name: string; start: number; end: number }[] = [];
  for (const match of code.matchAll(declaration)) {
    const name = match[1] ?? match[2];
    if (name) spans.push({ name, start: match.index, end: statementEnd(code, match.index) });
  }
  for (const match of code.matchAll(method)) {
    const name = match[1];
    if (!name || KEYWORDS.has(name)) continue;
    const start = match.index;
    const end = statementEnd(code, start);
    // A method has a body; a call statement such as `name(…);` does not.
    if (/\)\s*(?::[^{;]+)?\{/.test(code.slice(start, Math.min(end, code.indexOf("{", start) + 1)))) spans.push({ name, start, end });
  }
  return spans;
};

/** The arguments of the call whose opening parenthesis is at `open`. */
const callArguments = (code: string, open: number): string => {
  let depth = 0;
  for (let at = open; at < code.length; at += 1) {
    if (code[at] === "(" || code[at] === "{" || code[at] === "[") depth += 1;
    else if (code[at] === ")" || code[at] === "}" || code[at] === "]") {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, at);
    }
  }
  return code.slice(open + 1);
};

const isComment = (line: string): boolean => /^\s*(?:\/\/|\/\*|\*)/.test(line);

/** Has a `// runtime-timer: <reason>` on the same line or the line above. */
const marked = (lines: readonly string[], index: number): boolean =>
  [lines[index], lines[index - 1]].some((line) => (line?.match(MARKER)?.[1]?.trim().length ?? 0) >= MIN_REASON_LENGTH);

const lineOf = (code: string, offset: number): number => {
  let line = 0;
  for (let at = code.indexOf("\n"); at !== -1 && at < offset; at = code.indexOf("\n", at + 1)) line += 1;
  return line;
};

/**
 * 1-based lines of unmarked timers, self-scheduling loops and supervised tasks, and of `createSync(` calls in
 * `source`. A `setTimeout` is a loop when its arguments name a function whose declaration encloses the call:
 * `setTimeout(poll)`, `setTimeout(() => { … poll() })`, `setTimeout(() => work().finally(poll))`. It is a
 * heuristic over these shapes; a loop through another function or a variable is not seen.
 */
export const backgroundWorkFindings = (source: string, { allowCreateSync = false } = {}): { line: number; kind: "timer" | "sync" }[] => {
  const lines = source.split("\n");
  const code = codeOnly(source);
  const spans = functionSpans(code);
  const found = new Map<string, { line: number; kind: "timer" | "sync" }>();
  const add = (offset: number, kind: "timer" | "sync") => {
    const index = lineOf(code, offset);
    // A comment line whose block opened in another snippet (a fragment) counts as a comment too.
    if (isComment(lines[index] ?? "") || (kind === "timer" && marked(lines, index))) return;
    found.set(`${index}:${kind}`, { line: index + 1, kind });
  };
  for (const match of code.matchAll(timerCall)) add(match.index, "timer");
  for (const match of code.matchAll(timeoutCall)) {
    const at = match.index;
    const args = callArguments(code, at + match[0].length - 1);
    const loops = spans.some(
      ({ name, start, end }) =>
        start < at && at < end && new RegExp(`(?:(?<![\\w$.])|(?<=\\bthis\\.))${escapeRegExp(name)}(?![\\w$])`).test(args),
    );
    if (loops) add(at, "timer");
  }
  if (!allowCreateSync) for (const match of code.matchAll(createSyncCall)) add(match.index, "sync");
  return [...found.values()].sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
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
