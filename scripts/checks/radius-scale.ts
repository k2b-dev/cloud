import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { workspacePackages } from "../workspace";
import { compareBaseline, type KeyedFinding } from "./baseline";
import { isTestFile, listFiles } from "./files";
import type { Rule } from "./rule";

/**
 * K4 of Cloud flach: round is what a person presses, square is what orders. A radius is one of five values — 0, 4 px,
 * 8 px, 14 px, or fully round — or a radius token (`var(--k2b-radius-*)`, `var(--ui-radius-*)`, or any custom property
 * named `*radius*`, whose own definition this rule checks). In TSX, Tailwind `rounded-*` utilities follow the same
 * scale: `rounded-none`, `rounded`, `rounded-sm` (4 px), `rounded-lg` (8 px), `rounded-full`, or an arbitrary value
 * that passes. Known findings live in `radius-scale.baseline`; migrations remove lines, the rule never adds one.
 */
const RULE = "radius-scale";
const HEADER = [
  "Known radii outside the K4 scale (0, 4 px, 8 px, 14 px, round, or a radius token), one per occurrence:",
  "<file> | <css|class|style> | <value>. Lanes remove lines as they migrate; the rule never adds lines.",
  "`bun scripts/check.ts radius-scale --fix` removes lines whose finding is gone.",
];
const message =
  "use a radius role (`--k2b-radius-flat` 0, `-mark` 4 px, `-control` 8 px, `-overlay` 8 px, `-round`, `-card` 14 px) or rounded-none/sm/lg/full; see /en/ui/surfaces/flat-criteria (K4)";

const scaleLength = /^(?:0|0?\.0+|0(?:px|rem|em)|4px|0?\.25rem|8px|0?\.5rem|14px|0?\.875rem|50%|100%)$/;

/** A length of at least 999 px or 62 rem is the "fully round" of a pill or a person. */
const isRound = (part: string) => {
  const match = part.match(/^(\d+(?:\.\d+)?)(px|rem|em)$/);
  return match !== null && Number.parseFloat(match[1]!) >= (match[2] === "px" ? 999 : 62);
};

/** Splits a value at top-level whitespace and slashes; functions stay whole. */
const parts = (value: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0 && (/\s/.test(char) || char === "/")) {
      if (current) out.push(current);
      current = "";
    } else current += char;
  }
  if (current) out.push(current);
  return out;
};

/** True when every part of a radius value is on the scale or reads a radius token. */
export const onScale = (value: string): boolean => {
  const cleaned = value.replace(/!important/gi, "").trim();
  if (/^(?:inherit|initial|unset|revert|revert-layer|none)$/i.test(cleaned)) return true;
  return parts(cleaned).every((part) => {
    if (scaleLength.test(part) || isRound(part)) return true;
    const variable = part.match(/^var\(\s*(--[\w-]+)\s*(?:,(.*))?\)$/s);
    if (variable) return /radius/i.test(variable[1]!) && (variable[2] === undefined || onScale(variable[2]));
    return false;
  });
};

const tailwindOk = /^(?:none|sm|lg|full)?$/;
/** A Tailwind radius utility with any variants and side: `md:rounded-t-xl`, `rounded-[10px]`. */
const roundedUtility =
  /(?<![\w-])(?:[\w-]+(?:\/[\w-]+)?:)*!?rounded(?:-(?:s|e|t|r|b|l|ss|se|es|ee|tl|tr|br|bl))?(?:-(\w+|\[[^\]\s]+\]))?(?![\w[-])/g;

export const utilityOnScale = (size: string | undefined): boolean => {
  if (size === undefined || tailwindOk.test(size)) return true;
  if (size.startsWith("[")) return onScale(size.slice(1, -1).replace(/_/g, " "));
  return false;
};

const blankComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;

export const radiusFindings = (workspaceRoot: string, file: string, original: string): KeyedFinding[] => {
  const path = relative(workspaceRoot, file);
  const findings: KeyedFinding[] = [];
  const add = (index: number, kind: "css" | "class" | "style", value: string) =>
    findings.push({
      file,
      line: lineOf(original, index),
      key: `${path} | ${kind} | ${value.replace(/\s+/g, " ")}`,
      message: `${kind} radius ${value}: ${message}`,
    });
  if (file.endsWith(".css")) {
    const source = blankComments(original);
    for (const match of source.matchAll(/(?<=[{;]\s*)(@apply\s+|[\w-]+\s*:\s*)([^;{}]*)/g)) {
      const head = match[1] ?? "";
      const value = (match[2] ?? "").trim().replace(/\s+/g, " ");
      if (head.startsWith("@apply")) {
        for (const utility of value.matchAll(roundedUtility)) if (!utilityOnScale(utility[1])) add(match.index ?? 0, "class", utility[0]);
        continue;
      }
      const property = head.replace(/\s*:\s*$/, "");
      const isRadius = /^border(?:-[\w-]+)?-radius$/i.test(property) || (property.startsWith("--") && /radius/i.test(property));
      if (isRadius && !onScale(value)) add(match.index ?? 0, "css", value);
    }
    return findings;
  }
  const source = original.replace(/^[ \t]*(?:\/\/|\/\*|\*).*$/gm, (line) => " ".repeat(line.length));
  for (const literal of source.matchAll(/(["'])((?:(?!\1)[^\\\n]|\\.)*)\1|`((?:[^\\`]|\\.)*)`/g)) {
    const text = literal[2] ?? literal[3] ?? "";
    const start = (literal.index ?? 0) + 1;
    for (const utility of text.matchAll(roundedUtility))
      if (!utilityOnScale(utility[1])) add(start + (utility.index ?? 0), "class", utility[0]);
    for (const style of text.matchAll(/border(?:-[\w-]+)?-radius\s*:\s*([^;}\n"'`]+)/g))
      if (!onScale(style[1] ?? "")) add(start + (style.index ?? 0), "style", (style[1] ?? "").trim());
  }
  for (const style of source.matchAll(/\bborder\w*Radius\s*:\s*(["'`])([^"'`]*)\1/g))
    if (!onScale(style[2] ?? "")) add(style.index ?? 0, "style", (style[2] ?? "").trim());
  return findings;
};

export const collectRadiusFindings = (workspaceRoot: string): KeyedFinding[] =>
  workspacePackages(workspaceRoot)
    .flatMap((pkg) => listFiles(join(workspaceRoot, pkg, "src"), /\.(?:ts|tsx|css)$/))
    .filter((file) => !isTestFile(file) && !/browser-harness|browser-suite/.test(file))
    .sort()
    .flatMap((file) => radiusFindings(workspaceRoot, file, readFileSync(file, "utf8")));

export const rule: Rule = {
  name: RULE,
  description: "Radii come from the K4 scale (0, 4, 8, 14 px, round) or a radius token; known findings in a baseline",
  run: async ({ workspaceRoot, fix }) => compareBaseline(workspaceRoot, RULE, HEADER, collectRadiusFindings(workspaceRoot), fix),
};
