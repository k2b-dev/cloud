import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { workspacePackages } from "../workspace";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * Shadows come only from the @k2b/ui layer tokens (`--k2b-shadow-*`, the island
 * hook `--k2b-island-shadow`, the glass lift `--k2b-overlay-lift`). A raw shadow
 * is any box-shadow layer, drop-shadow, or Tailwind shadow utility with a blur:
 * rings and hairlines (blur 0, such as `inset 0 0 0 2px`, `inset 0 -1px 0`) are
 * edges, not depth, and stay allowed. Only @k2b/ui's token blocks define shadow
 * values. A justified exception names its reason in a comment on the line above:
 * `shadow-tokens: allow <reason>`.
 */
const message =
  "use a layer token instead (`--k2b-island-shadow` for islands via Paper, Section, or the hook; `--k2b-shadow-toolbar`, `-side`, `-sheet`, `-float`, `-toast`); see /en/ui/surfaces/elevation";

/** The @k2b/ui token owners: the component scope and the classless base stylesheet that mirrors it. */
const tokenFiles = new Set(["packages/ui/src/styles/index.css", "packages/ui/src/base/base.css"]);
const tokenName = /^--k2b-(?:shadow-[\w-]+|overlay-lift)$/;
const allowMarker = /shadow-tokens:\s*allow\s+\S/;

/** Removes `var(...)` references (with nested fallbacks) so only literal shadow layers remain. */
const stripVars = (value: string): string => {
  let out = value;
  for (let previous = ""; previous !== out; ) {
    previous = out;
    out = out.replace(/var\(\s*--[\w-]+\s*(?:,[^()]*(?:\([^()]*\)[^()]*)*)?\)/g, " ");
  }
  return out;
};

/** Splits a shadow list at top-level commas. */
const layers = (value: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      out.push(value.slice(start, index));
      start = index + 1;
    }
  }
  out.push(value.slice(start));
  return out.map((layer) => layer.trim()).filter(Boolean);
};

const length = /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em)?$/;
const colorFunction = /\b(?:rgba?|hsla?|color-mix|oklch|oklab|lab|lch|hwb)\([^()]*(?:\([^()]*\)[^()]*)*\)/gi;

/** A layer with a blur radius above zero casts depth; a ring or hairline (blur 0) is an edge. */
export const castsDepth = (value: string): boolean =>
  layers(stripVars(value.replace(/!important/gi, ""))).some((layer) => {
    const lengths = layer
      .replace(colorFunction, " ")
      // A computed length such as `calc(8px)` counts as a non-zero length.
      .replace(/\b(?:calc|min|max|clamp)\([^()]*(?:\([^()]*\)[^()]*)*\)/gi, " 1px ")
      .split(/\s+/)
      .filter((token) => length.test(token));
    const blur = lengths[2];
    return blur !== undefined && Number.parseFloat(blur) !== 0;
  });

/**
 * Tailwind shadow utilities: the sized ones, bare `shadow`, and arbitrary values. Colour utilities and `shadow-none`
 * do not match; an arbitrary value counts only when it casts depth (`shadow-[var(--k2b-shadow-float)]` and rings pass).
 */
const shadowUtility =
  /(?<![\w-])(?:[\w-]+(?:\/[\w-]+)?:)*!?(?:drop-)?shadow(?:-(?:2xs|xs|sm|md|lg|xl|2xl|inner)|-\[([^\]\s]*)\])?(?![\w[(-])/g;

/** The shadow of each `drop-shadow(...)` in a filter value. */
const dropShadows = (value: string): string[] =>
  [...value.matchAll(/drop-shadow\(((?:[^()]|\([^()]*(?:\([^()]*\)[^()]*)*\))*)\)/gi)].map((match) => match[1] ?? "");

const utilityCastsDepth = (match: RegExpMatchArray): boolean => {
  const arbitrary = match[1];
  if (arbitrary === undefined) return true;
  return castsDepth(arbitrary.replace(/_/g, " "));
};

const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;

const allowedAbove = (source: string, index: number): boolean => {
  const lines = source.slice(0, index).split("\n");
  const current = lines.at(-1) ?? "";
  const previous = lines.at(-2) ?? "";
  return allowMarker.test(current) || allowMarker.test(previous);
};

const checkCss = (original: string, isTokenFile: boolean, report: (index: number, detail: string) => void) => {
  // Comments become blanks of the same length, so offsets stay true; allow markers are read from the original.
  const source = original.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  // A custom property that a box-shadow or filter reads as a whole layer is a shadow, whatever its name; one that
  // fills a colour function, such as `rgb(var(--glow) / 0.2)`, is a colour.
  const readAsShadow = new Set(
    [...source.matchAll(/(?:box-shadow|filter)\s*:[^;{}]*/gi)].flatMap((match) =>
      [...match[0].replace(colorFunction, " ").matchAll(/var\(\s*(--[\w-]+)/g)].map((use) => use[1]),
    ),
  );
  // Every declaration, also inside nested rules and at-rules: it starts after `{` or `;`.
  for (const declaration of source.matchAll(/(?<=[{;]\s*)(@apply\s+|[\w-]+\s*:\s*)([^;{}]*)/g)) {
    const head = declaration[1] ?? "";
    const value = declaration[2] ?? "";
    const at = declaration.index ?? 0;
    if (allowedAbove(original, at)) continue;
    const open = source.lastIndexOf("{", at);
    const selector = source
      .slice(Math.max(source.lastIndexOf("}", open), source.lastIndexOf(";", open), source.lastIndexOf("{", open - 1)) + 1, open)
      .trim()
      .replace(/\s+/g, " ");
    if (head.startsWith("@apply")) {
      for (const utility of value.matchAll(shadowUtility)) if (utilityCastsDepth(utility)) report(at, `${selector} applies ${utility[0]}`);
      continue;
    }
    const property = head.replace(/\s*:\s*$/, "");
    if (property.startsWith("--")) {
      if (isTokenFile && tokenName.test(property)) continue;
      if ((/shadow|depth|lift|elevation/i.test(property) || readAsShadow.has(property)) && castsDepth(value))
        report(at, `${selector} defines ${property}: ${value.trim()}`);
      continue;
    }
    if (/^(?:-webkit-)?box-shadow$/i.test(property) && castsDepth(value)) report(at, `${selector} sets box-shadow: ${value.trim()}`);
    if (/^(?:-webkit-)?filter$/i.test(property) && dropShadows(value).some(castsDepth))
      report(at, `${selector} sets filter: ${value.trim()}`);
  }
};

/** A literal that looks like a Tailwind class list: several utility tokens, at least one with a dash. */
const isClassList = (text: string): boolean => {
  const tokens = text.trim().split(/\s+/);
  return tokens.length > 1 && tokens.every((token) => /^[!\w:/[\]().%#,-]+$/.test(token)) && tokens.some((token) => token.includes("-"));
};

const checkSource = (original: string, report: (index: number, detail: string) => void) => {
  // Comment lines become blanks of the same length; prose such as "a denial shadows a grant" is no class.
  const source = original.replace(/^[ \t]*(?:\/\/|\/\*|\*).*$/gm, (line) => " ".repeat(line.length));
  // Quoted strings end at the line; template literals may span lines, as long class lists do.
  for (const literal of source.matchAll(/(["'])((?:(?!\1)[^\\\n]|\\.)*)\1|`((?:[^\\`]|\\.)*)`/g)) {
    const text = literal[2] ?? literal[3] ?? "";
    const start = (literal.index ?? 0) + 1;
    // A literal right after `class=` or `className=` is a class list even with one class.
    const isClassAttribute = /\bclass(?:Name)?\s*=\s*\{?\s*$/.test(source.slice(Math.max(0, start - 24), start - 1));
    for (const match of text.matchAll(shadowUtility)) {
      // A bare `shadow` counts only in a class list, never as a word in prose, an SVG filter id, or keywords.
      if (match[0] === "shadow" && !isClassAttribute && !isClassList(text)) continue;
      const index = start + (match.index ?? 0);
      if (utilityCastsDepth(match) && !allowedAbove(original, index)) report(index, match[0]);
    }
    // Inline style strings, such as `style="box-shadow: …"`.
    for (const match of text.matchAll(/box-shadow\s*:\s*([^;]+)/g)) {
      const index = start + (match.index ?? 0);
      if (castsDepth(match[1] ?? "") && !allowedAbove(original, index)) report(index, `box-shadow: ${match[1]}`);
    }
  }
  for (const match of source.matchAll(/(?:boxShadow|"box-shadow"|'box-shadow')\s*:\s*(["'`])([^"'`]*)\1/g)) {
    const index = match.index ?? 0;
    if (castsDepth(match[2] ?? "") && !allowedAbove(original, index)) report(index, `boxShadow: ${match[2]}`);
  }
  for (const match of source.matchAll(/filter\s*:\s*(["'`])([^"'`]*drop-shadow[^"'`]*)\1/g)) {
    const index = match.index ?? 0;
    if (dropShadows(match[2] ?? "").some(castsDepth) && !allowedAbove(original, index)) report(index, `filter: ${match[2]}`);
  }
};

export const rule: Rule = {
  name: "shadow-tokens",
  description: "Shadows come only from the @k2b/ui layer tokens; rings and hairlines stay allowed",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    for (const pkg of workspacePackages(workspaceRoot)) {
      for (const file of listFiles(join(workspaceRoot, pkg, "src"), /\.(?:ts|tsx|css)$/)) {
        if (isTestFile(file) || /\.(?:browser|behavior|render|contract)\.test\.tsx?$|browser-harness|browser-suite/.test(file)) continue;
        const original = readFileSync(file, "utf8");
        const report = (index: number, detail: string) =>
          findings.push({ file, line: lineOf(original, index), message: `${detail}: ${message}` });
        if (file.endsWith(".css")) checkCss(original, tokenFiles.has(relative(workspaceRoot, file)), report);
        else checkSource(original, report);
      }
    }
    return findings;
  },
};
