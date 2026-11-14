import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { workspacePackages } from "../workspace";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * Cloud has one scrollbar. @k2b/ui draws it for every scroller from one central rule in
 * `packages/ui/src/styles/index.css`, between the `scrollbars: central rule begin` and `end` markers. Anywhere else a
 * stylesheet or component may hide a scrollbar (`scrollbar-width: none`, `::-webkit-scrollbar { display: none }` or a
 * zero width and height, Tailwind `[scrollbar-width:none]` or `[&::-webkit-scrollbar]:hidden`) and reserve its room
 * (`scrollbar-gutter`, `overflow`), but never set its own width, colour, or `::-webkit-scrollbar` look: Chromium
 * ignores the shared ::-webkit-scrollbar rules of an element with any `scrollbar-width` or `scrollbar-color`, so one
 * local value draws a different scrollbar. A justified exception names its reason in a comment on the line above the
 * declaration or its selector: `scrollbars: allow <reason>`.
 */
const message =
  "draws its own scrollbar; the shared one in @k2b/ui applies everywhere, only hiding is allowed: see /en/ui/layout/scroll-area#scrollbars";

const centralFile = "packages/ui/src/styles/index.css";
const allowMarker = /scrollbars:\s*allow\s+\S/;
const centralBegin = "scrollbars: central rule begin";
const centralEnd = "scrollbars: central rule end";

const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;

const allowedNear = (original: string, ...indexes: number[]): boolean => {
  const lines = original.split("\n");
  return indexes.some((index) => {
    const line = lineOf(original, index) - 1;
    return allowMarker.test(lines[line] ?? "") || allowMarker.test(lines[line - 1] ?? "");
  });
};

/** The source ranges between the central markers, where the shared scrollbar is defined. */
const centralRanges = (original: string): [number, number][] => {
  const ranges: [number, number][] = [];
  for (let start = original.indexOf(centralBegin); start !== -1; start = original.indexOf(centralBegin, start + 1)) {
    const end = original.indexOf(centralEnd, start);
    ranges.push([start, end === -1 ? original.length : end]);
  }
  return ranges;
};

/** The selectors of the block that opens at `open` and of every block around it, innermost first. */
const selectorChain = (source: string, open: number): string[] => {
  const chain: string[] = [];
  for (let brace = open; brace !== -1; brace = enclosingBrace(source, brace)) {
    const start = Math.max(source.lastIndexOf("}", brace), source.lastIndexOf(";", brace), source.lastIndexOf("{", brace - 1)) + 1;
    chain.push(source.slice(start, brace).trim());
  }
  return chain;
};

const hides = (property: string, value: string, scrollbarRule: boolean): boolean => {
  if (scrollbarRule)
    return (property === "display" && value === "none") || (/^(?:width|height)$/.test(property) && /^0(?:px|rem)?$/.test(value));
  return property === "scrollbar-width" && value === "none";
};

/** The `{` of the block that contains `index`, skipping nested blocks that closed before it. */
const enclosingBrace = (source: string, index: number): number => {
  let depth = 0;
  for (let at = index - 1; at >= 0; at -= 1) {
    if (source[at] === "}") depth += 1;
    else if (source[at] === "{") {
      if (depth === 0) return at;
      depth -= 1;
    }
  }
  return -1;
};

export const checkCss = (original: string, isCentralFile: boolean, report: (index: number, detail: string) => void) => {
  // Comments become blanks of the same length, so offsets stay true; markers are read from the original.
  const source = original.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const central = isCentralFile ? centralRanges(original) : [];
  // Every declaration, also inside nested rules and at-rules: it starts after `{` or `;`.
  for (const declaration of source.matchAll(/(?<=[{;]\s*)([\w-]+)\s*:\s*([^;{}]*)/g)) {
    const property = (declaration[1] ?? "").toLowerCase();
    const value = (declaration[2] ?? "").replace(/!important/i, "").trim();
    const at = declaration.index ?? 0;
    const open = enclosingBrace(source, at);
    const selectorStart = Math.max(source.lastIndexOf("}", open), source.lastIndexOf(";", open), source.lastIndexOf("{", open - 1)) + 1;
    const selector = source.slice(selectorStart, open).trim().replace(/\s+/g, " ");
    // A nested rule (`&:hover`, `@media`) styles the scrollbar part of any rule around it.
    const scrollbarRule = selectorChain(source, open).some((part) => !part.startsWith("@") && part.includes("::-webkit-scrollbar"));
    if (!scrollbarRule && property !== "scrollbar-width" && property !== "scrollbar-color") continue;
    if (scrollbarRule && property.startsWith("--")) continue;
    if (hides(property, value, scrollbarRule)) continue;
    if (central.some(([start, end]) => at > start && at < end)) continue;
    const firstSelectorChar = selectorStart + (source.slice(selectorStart).length - source.slice(selectorStart).trimStart().length);
    if (allowedNear(original, at, firstSelectorChar)) continue;
    report(at, `${selector} sets ${property}: ${value}`);
  }
};

export const checkSource = (original: string, report: (index: number, detail: string) => void) => {
  // Comment lines become blanks of the same length; prose about scrollbars is no style.
  const source = original.replace(/^[ \t]*(?:\/\/|\/\*|\*).*$/gm, (line) => " ".repeat(line.length));
  for (const match of source.matchAll(/scrollbar-?[cC]olor/g)) {
    const index = match.index ?? 0;
    if (!allowedNear(original, index)) report(index, match[0]);
  }
  // `[scrollbar-width:none]`, `"scrollbar-width": "none"`, `scrollbarWidth: "none"`, and CSS text in strings.
  for (const match of source.matchAll(/scrollbar-?[wW]idth["']?\s*:\s*["']?([\w-]+)/g)) {
    const index = match.index ?? 0;
    if (match[1] !== "none" && !allowedNear(original, index)) report(index, match[0]);
  }
  for (const match of source.matchAll(/::-webkit-scrollbar[\w-]*/g)) {
    const index = match.index ?? 0;
    const after = source.slice(index + match[0].length, index + match[0].length + 40);
    if (/^\]:hidden\b/.test(after) || /^\s*\{\s*display:\s*none;?\s*\}/.test(after)) continue;
    if (!allowedNear(original, index)) report(index, match[0]);
  }
};

export const rule: Rule = {
  name: "scrollbars",
  description: "Scrollbars come only from the shared @k2b/ui rule; elsewhere a scrollbar may only be hidden",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    for (const pkg of workspacePackages(workspaceRoot)) {
      for (const file of listFiles(join(workspaceRoot, pkg, "src"), /\.(?:ts|tsx|css)$/)) {
        if (isTestFile(file) || /browser-harness|browser-suite/.test(file)) continue;
        const original = readFileSync(file, "utf8");
        if (!/scrollbar-?[wWcC]|::-webkit-scrollbar/.test(original)) continue;
        const report = (index: number, detail: string) =>
          findings.push({ file, line: lineOf(original, index), message: `${detail}: ${message}` });
        if (file.endsWith(".css")) checkCss(original, relative(workspaceRoot, file) === centralFile, report);
        else checkSource(original, report);
      }
    }
    return findings;
  },
};
