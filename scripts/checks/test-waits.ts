import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { listFiles } from "./files";
import type { Finding, Rule } from "./rule";

const BASELINE = "scripts/checks/test-waits.baseline";
const testWaitFiles = /\.test\.tsx?$/;
const message =
  "Wait for an observable condition with a bounded deadline (poll it, await an event, a log, a hook, or a recorded state), or add // fixed wait: <reason>.";

/** Read a call's arguments from code whose comments and strings have been blanked. */
const callArguments = (code: string, opening: number): { end: number; args: string[] } => {
  const args: string[] = [];
  let depth = 1;
  let start = opening + 1;
  for (let i = start; i < code.length; i++) {
    const char = code[i];
    if (char === "(" || char === "[" || char === "{") depth++;
    if (char === ")" || char === "]" || char === "}") depth--;
    if (depth === 0) return { end: i, args: [...args, code.slice(start, i)] };
    if (char === "," && depth === 1) {
      args.push(code.slice(start, i));
      start = i + 1;
    }
  }
  return { end: code.length, args };
};

const fixedDuration = (arg: string | undefined): boolean =>
  arg !== undefined &&
  /^\s*(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)\s*$/.test(arg) &&
  Number(arg.replaceAll("_", "")) >= 1_000;

const isTimerOnlyPromise = (executor: string): boolean => {
  const parameter = /^\s*(?:function(?:\s+[\w$]+)?\s*\(\s*|\(\s*)?([A-Za-z_$][\w$]*)\s*(?=[,)]|=>)/.exec(executor);
  if (!parameter) return false;
  const resolve = parameter[1]!;
  const referencesResolve = new RegExp(`(?<![\\w$])${resolve.replaceAll("$", "\\$")}(?![\\w$])`);
  // Skip the parameter binding; only uses outside timer callbacks disqualify a sleep.
  const body = executor.slice(parameter[0].length);
  let outsideCallbacks = body;
  let timerResolves = false;
  for (const timer of body.matchAll(/\bsetTimeout\s*\(/g)) {
    const opening = timer.index + timer[0].lastIndexOf("(");
    const { args } = callArguments(body, opening);
    if (!fixedDuration(args[1])) continue;
    const callback = args[0] ?? "";
    const functionBody = /^\s*(?:function(?:\s+[\w$]+)?\s*\([^)]*\)|(?:\([^)]*\)|[\w$]+)\s*=>)([\s\S]*)$/.exec(callback)?.[1];
    if (callback.trim() !== resolve && !(functionBody && referencesResolve.test(functionBody))) continue;
    timerResolves = true;
    const start = opening + 1;
    outsideCallbacks = outsideCallbacks.slice(0, start) + " ".repeat(callback.length) + outsideCallbacks.slice(start + callback.length);
  }
  return timerResolves && !referencesResolve.test(outsideCallbacks);
};

/** Blank comments and strings without changing positions or line numbers. */
export const checkTestWaitsSource = (file: string, source: string): Finding[] => {
  const optOuts = new Set<number>();
  const code = source.replace(
    /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    (token, offset: number) => {
      if (/^\/\/[ \t]*fixed wait:[ \t]*\S/.test(token)) optOuts.add(source.slice(0, offset).split("\n").length);
      return token.replace(/[^\r\n]/g, " ");
    },
  );
  const findings: Finding[] = [];
  for (const match of code.matchAll(/\bawait\s+(?:(?:Bun\s*\.\s*)?sleep\s*\(|new\s+Promise(?:\s*<[^>]*>)?\s*\()/g)) {
    const opening = match.index + match[0].lastIndexOf("(");
    const call = callArguments(code, opening);
    let fixed = fixedDuration(call.args[0]);
    if (/\bnew\s+Promise\b/.test(match[0])) {
      fixed = isTimerOnlyPromise(call.args[0] ?? "");
    }
    const line = code.slice(0, match.index).split("\n").length;
    if (fixed && !optOuts.has(line) && !optOuts.has(line - 1)) findings.push({ file, line, message });
  }
  return findings;
};

export const collectTestWaitsFindings = (workspaceRoot: string): Finding[] =>
  ["packages", "pwas", "docs-site/src", "scripts"]
    .flatMap((root) => listFiles(join(workspaceRoot, root), testWaitFiles))
    .sort()
    .flatMap((file) => checkTestWaitsSource(relative(workspaceRoot, file), readFileSync(file, "utf8")));

const BASELINE_HEADER = [
  "# Known test-waits findings, one per file: <file> | <count>.",
  "# Migrations lower counts and remove entries; the rule never raises counts or adds lines.",
  "# `bun scripts/check.ts test-waits --fix` lowers counts whose findings are gone.",
];
export const formatBaseline = (counts: ReadonlyMap<string, number>): string =>
  `${[...BASELINE_HEADER, ...[...counts].map(([file, count]) => `${file} | ${count}`).sort()].join("\n")}\n`;

const readBaseline = (path: string): Map<string, number> => {
  const counts = new Map<string, number>();
  if (!existsSync(path)) return counts;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const match = /^(.+) \| ([1-9]\d*)$/.exec(line);
    if (!match) throw new Error(`Invalid test-waits baseline entry: ${line}`);
    counts.set(match[1]!, Number(match[2]));
  }
  return counts;
};

export const rule: Rule = {
  name: "test-waits",
  description: "Tests wait for observable conditions with bounded deadlines",
  run: async ({ workspaceRoot, fix }) => {
    const baselinePath = join(workspaceRoot, BASELINE);
    const baseline = readBaseline(baselinePath);
    const byFile = new Map<string, Finding[]>();
    for (const finding of collectTestWaitsFindings(workspaceRoot)) {
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
          message: `${file} has ${actual} finding(s), below its baseline of ${count}; lower/remove the entry (bun scripts/check.ts test-waits --fix).`,
        });
      }
    }
    if (lowered) writeFileSync(baselinePath, formatBaseline(baseline));
    return failures;
  },
};
