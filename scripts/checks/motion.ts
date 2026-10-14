/**
 * Motion hygiene, phase 1: only CSS below packages/ui/src is in scope.
 * New layout transitions and layout keyframes fail; time and curve literals
 * only warn. Tightening the check step by step keeps unrelated pull requests
 * moving while migrations remove known findings from the baseline.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { listFiles } from "./files";
import type { Finding, Rule } from "./rule";

export type MotionFinding = { file: string; line: number; key: string; kind: "layout" | "literal"; message: string };
const BASELINE = "scripts/checks/motion.baseline";
const layoutProperty = (property: string) =>
  /^(?:(?:min-|max-)?(?:width|height|inline-size|block-size)|(?:padding|margin|inset)(?:-[\w-]+)?|top|right|bottom|left)$/.test(property);
const motionProperty = /^(?:transition|animation)(?:-(?:duration|delay|timing-function))?$/;
const easing = /^(?:ease(?:-in(?:-out)?|-out)?|linear|step-start|step-end|cubic-bezier\(.*\)|steps\(.*\)|linear\(.*\))$/;
const times = /(?<![\w.-])[+-]?(?:\d*\.)?\d+(?:ms|s)(?![\w-])/g;

/** Top-level tokens: functions and quoted names stay intact, commas separate shorthand entries. */
const valueTokens = (value: string): string[][] => {
  const parts: string[][] = [[]];
  let start = 0;
  let depth = 0;
  let quote = "";
  const flush = (end: number) => {
    const token = value.slice(start, end).trim();
    if (token) parts.at(-1)!.push(token.replace(/\s+/g, " "));
    start = end + 1;
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (depth === 0 && (character === "," || /\s/.test(character))) {
      flush(index);
      if (character === ",") parts.push([]);
    }
  }
  flush(value.length);
  return parts;
};

/** Remove whole var() calls, including nested fallbacks. */
const withoutVariables = (value: string): string => {
  let result = "";
  let cursor = 0;
  const variables = /\bvar\(/g;
  for (let match = variables.exec(value); match; match = variables.exec(value)) {
    result += value.slice(cursor, match.index);
    let depth = 1;
    let end = variables.lastIndex;
    for (; end < value.length && depth > 0; end += 1) {
      if (value[end] === "(") depth += 1;
      else if (value[end] === ")") depth -= 1;
    }
    result += " ";
    cursor = end;
    variables.lastIndex = end;
  }
  return result + value.slice(cursor);
};

/** Strip variants outside arbitrary values and leading or trailing important markers. */
const utilityName = (utility: string): string => {
  let start = 0;
  let depth = 0;
  for (let index = 0; index < utility.length; index += 1) {
    if (utility[index] === "[") depth += 1;
    else if (utility[index] === "]") depth -= 1;
    else if (utility[index] === ":" && depth === 0) start = index + 1;
  }
  return utility.slice(start).replace(/^!|!$/g, "");
};

/** Checks declarations and @apply, including multiline values and nested at-rules, at their starting source line. */
export const checkMotionSource = (file: string, source: string): MotionFinding[] => {
  const css = source.replace(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\*[\s\S]*?\*\//g, (token) =>
    token.startsWith("/*") ? token.replace(/[^\n]/g, " ") : token,
  );
  const findings: MotionFinding[] = [];
  const blocks: (string | undefined)[] = [];
  let start = 0;
  let line = 1;
  let startLine = 1;
  let depth = 0;
  let quote = "";

  const declaration = (end: number) => {
    const text = css.slice(start, end);
    const declarationLine = startLine + (text.match(/^\s*/)?.[0].match(/\n/g)?.length ?? 0);
    const add = (kind: MotionFinding["kind"], detail: string, message: string) =>
      findings.push({ file, line: declarationLine, key: `${file} | ${kind} | ${detail}`, kind, message });
    const layout = (name: string, keyframe?: string) =>
      add("layout", keyframe ? `@keyframes ${keyframe} ${name}` : name, `Do not animate ${name}; animate transform/opacity instead.`);
    /** Use the same literal finding for declarations and applied utilities. */
    const literal = (value: string) => add("literal", value, `Use the motion tokens (--k2b-motion-*, --k2b-ease-*) instead of ${value}.`);

    const apply = text.match(/^\s*@apply\s+([\s\S]*)$/);
    if (apply) {
      for (const utility of apply[1]!.trim().split(/\s+/).map(utilityName)) {
        if (utility === "transition-all") layout("all");
        const arbitrary = utility.match(/^(transition|duration|delay|ease)-\[([\s\S]*)\]$/);
        if (arbitrary) {
          const value = arbitrary[2]!.replace(/_/g, " ");
          if (arbitrary[1] === "transition") {
            for (const entry of value.toLowerCase().split(",")) {
              const name = entry.split(/\s+/).find((token) => token === "all" || layoutProperty(token));
              if (name) layout(name);
            }
          } else if (!value.startsWith("--")) {
            if (arbitrary[1] === "ease") {
              if (!/^var\(/.test(value)) literal(value);
            } else {
              for (const match of withoutVariables(value).matchAll(times)) {
                if (Number.parseFloat(match[0]) !== 0) literal(match[0]);
              }
            }
          }
        }
        const duration = utility.match(/^(?:duration|delay)-((?:\d*\.)?\d+)$/)?.[1];
        if (duration && Number.parseFloat(duration) !== 0) literal(`${duration}ms`);
        if (/^ease-(?:linear|in|out|in-out)$/.test(utility)) literal(utility);
      }
      return;
    }

    const match = text.match(/^\s*([\w-]+)\s*:\s*([\s\S]*)$/);
    if (!match) return;
    const property = match[1]!.toLowerCase();
    const value = match[2]!.replace(/\s*!important\s*$/, "").trim();

    const keyframe = blocks.at(-1);
    if (keyframe && layoutProperty(property)) layout(property, keyframe);
    if (property === "transition" || property === "transition-property") {
      for (const tokens of valueTokens(value)) {
        const names = tokens.map((token) => token.toLowerCase());
        const name = names.find((token) => token === "all" || layoutProperty(token));
        if (name) layout(name);
        else if (
          property === "transition" &&
          !/^(?:none|inherit|initial|unset|revert|revert-layer)$/i.test(value) &&
          names.length > 0 &&
          names.every(
            (token) =>
              token.match(times)?.[0] === token ||
              easing.test(token) ||
              /^var\([\s\S]*\)$/.test(token) ||
              token === "allow-discrete" ||
              token === "normal",
          )
        )
          layout("all");
      }
    }
    if (!motionProperty.test(property)) return;
    for (const tokens of valueTokens(withoutVariables(value))) {
      for (const token of tokens) {
        if (token.startsWith('"') || token.startsWith("'")) continue;
        const literals = easing.test(token)
          ? [token]
          : [...token.matchAll(times)].map((match) => match[0]).filter((time) => Number.parseFloat(time) !== 0);
        for (const value of literals) literal(value);
      }
    }
  };

  for (let index = 0; index < css.length; index += 1) {
    const character = css[index]!;
    if (quote) {
      if (character === "\\") {
        if (css[index + 1] === "\n") line += 1;
        index += 1;
      } else if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth -= 1;
    else if (depth === 0 && (character === "{" || character === "}" || character === ";")) {
      if (character === "{") {
        const keyframe = css
          .slice(start, index)
          .trim()
          .match(/^@(?:-webkit-)?keyframes\s+([\w-]+)/)?.[1];
        blocks.push(keyframe ?? blocks.at(-1));
      } else {
        declaration(index);
        if (character === "}") blocks.pop();
      }
      start = index + 1;
      startLine = line;
    }
    if (character === "\n") line += 1;
  }
  return findings;
};

export const collectMotionFindings = (workspaceRoot: string): MotionFinding[] =>
  listFiles(join(workspaceRoot, "packages/ui/src"), /\.css$/)
    .sort()
    .flatMap((path) => checkMotionSource(relative(workspaceRoot, path), readFileSync(path, "utf8")));

const BASELINE_HEADER = [
  "# Known motion findings, one per line: <file> | <layout|literal> | <detail>.",
  "# Migrations remove lines until the file is empty; the rule never adds lines.",
  "# `bun scripts/check.ts motion --fix` removes lines whose finding is gone.",
];
export const formatBaseline = (keys: readonly string[]): string => `${[...BASELINE_HEADER, ...[...keys].sort()].join("\n")}\n`;
const readBaseline = (path: string): string[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
    : [];

export const rule: Rule = {
  name: "motion",
  description: "UI motion animates transform/opacity and uses shared time and curve tokens",
  run: async ({ workspaceRoot, fix, flags }) => {
    const baselinePath = join(workspaceRoot, BASELINE);
    const remaining = new Map<string, number>();
    for (const key of readBaseline(baselinePath)) remaining.set(key, (remaining.get(key) ?? 0) + 1);
    const known: MotionFinding[] = [];
    const failures: Finding[] = [];
    for (const finding of collectMotionFindings(workspaceRoot)) {
      const count = remaining.get(finding.key) ?? 0;
      if (count > 0) {
        remaining.set(finding.key, count - 1);
        known.push(finding);
      } else if (finding.kind === "layout") {
        failures.push({ file: join(workspaceRoot, finding.file), line: finding.line, message: finding.message });
      } else console.warn(`warn  motion: ${finding.file}:${finding.line} ${finding.message}`);
    }
    const stale = [...remaining].flatMap(([key, count]) => Array<string>(count).fill(key));
    if (stale.length > 0 && fix) writeFileSync(baselinePath, formatBaseline(known.map((finding) => finding.key)));
    else {
      for (const key of stale)
        failures.push({ file: baselinePath, message: `Fixed: remove “${key}” from the baseline (bun scripts/check.ts motion --fix).` });
    }
    if (known.length > 0) {
      console.warn(`warn  motion: ${known.length} known finding(s) in ${BASELINE}; list them with --warnings`);
      if (flags.has("--warnings")) {
        for (const finding of known) console.warn(`  - ${finding.file}:${finding.line} ${finding.message}`);
      }
    }
    return failures;
  },
};
