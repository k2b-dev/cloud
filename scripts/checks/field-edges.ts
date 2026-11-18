import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { workspacePackages } from "../workspace";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * Everything a person fills in or chooses has the thin field edge (Fibel `/en/ui/surfaces/color#field-edge`): 1 px from
 * `--k2b-edge-width`, a chosen card's second line from `--k2b-edge-selected-width`, and a large writing surface's own
 * frame from `--k2b-frame-width`. Only @k2b/ui's token block sets these widths. A line in a field-edge colour at a
 * fixed width other than 1 px (`2px`, `0.125rem`, `border-2`) rebuilds the old thick edge beside the contract and
 * is reported. A justified exception names its reason in a comment on the line above: `field-edges: allow <reason>`.
 * Depth shadows on controls are the `shadow-tokens` rule's job.
 */
const message =
  "draw field edges with `var(--k2b-edge-width)` (1 px), a chosen card's second line with `--k2b-edge-selected-width`, and a writing surface's frame with `--k2b-frame-width`; see /en/ui/surfaces/color#field-edge";

const tokenFile = "packages/ui/src/styles/index.css";
const widthTokens = /^--k2b-(?:edge-width|edge-selected-width|edge-ring-width|frame-width)$/;
/** The colours that only a field edge or its states use. */
const edgeColour = /var\(\s*--k2b-(?:edge(?:-(?:color|focus|danger|hover|disabled))?|control-border-soft)\s*[,)]/;
/** A fixed line width other than 1 px. Half pixels (check marks) and hairlines stay allowed. */
const thickWidth = /(?<![\w.-])(?:2|3)px\b|(?<![\w.-])0?\.125rem\b|(?<![\w.-])0?\.1875rem\b/;
const allowMarker = /field-edges:\s*allow\s+\S/;

const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;

const allowedAbove = (source: string, index: number): boolean => {
  const lines = source.slice(0, index).split("\n");
  return allowMarker.test(lines.at(-1) ?? "") || allowMarker.test(lines.at(-2) ?? "");
};

/** Splits a value at top-level commas, as box-shadow layers are. */
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

const checkCss = (original: string, isTokenFile: boolean, report: (index: number, detail: string) => void) => {
  // Comments become blanks of the same length, so offsets stay true; allow markers are read from the original.
  const source = original.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  for (const declaration of source.matchAll(/(?<=[{;]\s*)([\w-]+)\s*:\s*([^;{}]*)/g)) {
    const property = declaration[1] ?? "";
    const value = declaration[2] ?? "";
    const at = declaration.index ?? 0;
    if (allowedAbove(original, at)) continue;
    if (widthTokens.test(property)) {
      if (!isTokenFile) report(at, `${property} is set outside the @k2b/ui tokens`);
      continue;
    }
    if (!/^(?:border(?:-[\w-]+)?|outline|box-shadow)$/.test(property)) continue;
    for (const layer of property === "box-shadow" ? layers(value) : [value]) {
      if (edgeColour.test(layer) && thickWidth.test(layer)) report(at, `${property}: ${layer}`);
    }
  }
};

/** Tailwind: a thick border or ring in a field-edge colour inside one class list. */
const checkSource = (original: string, report: (index: number, detail: string) => void) => {
  for (const literal of original.matchAll(/(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
    const text = literal[2] ?? "";
    const thick = text.match(/(?<![\w-])(?:[\w-]+:)*(?:border|ring|outline)-(?:2|\[2px\])(?![\w-])/);
    if (!thick || !/(?:border|ring|outline)-\[var\(--k2b-(?:edge|control-border-soft)[\w-]*\)\]/.test(text)) continue;
    const index = (literal.index ?? 0) + 1 + (thick.index ?? 0);
    if (!allowedAbove(original, index)) report(index, thick[0]);
  }
};

export const rule: Rule = {
  name: "field-edges",
  description: "Field edges are 1 px from the @k2b/ui edge tokens; no thick edge rebuilt beside them",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    for (const pkg of workspacePackages(workspaceRoot)) {
      for (const file of listFiles(join(workspaceRoot, pkg, "src"), /\.(?:tsx|css)$/)) {
        if (isTestFile(file) || /\.(?:browser|behavior|render|contract)\.test\.tsx?$|browser-harness|browser-suite/.test(file)) continue;
        const original = readFileSync(file, "utf8");
        const report = (index: number, detail: string) =>
          findings.push({ file, line: lineOf(original, index), message: `${detail}: ${message}` });
        if (file.endsWith(".css")) checkCss(original, relative(workspaceRoot, file) === tokenFile, report);
        else checkSource(original, report);
      }
    }
    return findings;
  },
};
