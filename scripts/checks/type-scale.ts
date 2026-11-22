import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { workspacePackages } from "../workspace";
import { compareBaseline, type KeyedFinding } from "./baseline";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * K11 of Cloud flach: four type roles are the only text sizes in the controls — meta 12, row 13, body 14, lead 18 px —
 * and the weights are 400, 500, and 600. In CSS a `font-size` reads a role token (`var(--k2b-font-size-meta|row|body|
 * lead)`), a keyword such as `inherit`, or `1em`; a custom property named `*font-size*` follows the same rule. Two
 * places keep their own sizes by kind, recognised from the selector: reading text (Markdown and the editors, which
 * may set headings in em) and signs (icons, avatar initials, emoji), which size with their box. Anything else names its
 * reason in a comment on its line or the line above: `type-scale: allow <reason>`. In TSX, Tailwind sizes follow the
 * scale: `text-meta|row|body|lead`, `text-xs` (12/16) and `text-sm` (14/20), or an arbitrary value that passes;
 * `font-bold` and lighter or heavier weights fail. `@k2b/ui` has no known findings; the applications' known findings
 * live in `type-scale.baseline`, which only shrinks.
 */
const RULE = "type-scale";
const HEADER = [
  "Known text sizes and weights outside the four type roles (K11), one per occurrence:",
  "<file> | <size|weight> | <value>. App lanes remove lines as they migrate; the rule never adds lines.",
  "`bun scripts/check.ts type-scale --fix` removes lines whose finding is gone. @k2b/ui never appears here.",
];
const sizeMessage =
  "use a type role: var(--k2b-font-size-meta|row|body|lead) in CSS, text-meta|row|body|lead in classes (12, 13, 14, 18 px); see /en/ui/surfaces/utilities#type-roles (K11)";
const weightMessage =
  "use weight 400, 500, or 600 (font-normal, font-medium, font-semibold); see /en/ui/surfaces/utilities#type-roles (K11)";

const UI_SOURCE = "packages/ui/src/";
const keyword = /^(?:inherit|initial|unset|revert|revert-layer)$/i;
const roleToken = /^var\(\s*--k2b-font-size-(?:meta|row|body|lead)\s*\)$/;

/** A length in px; `rem` counts 16 px. Undefined when the value is not a plain length. */
const pixels = (value: string): number | undefined => {
  const match = value.match(/^(\d*\.?\d+)(px|rem)$/);
  if (!match) return undefined;
  return Number.parseFloat(match[1]!) * (match[2] === "rem" ? 16 : 1);
};
const ROLE_PIXELS = [12, 13, 14, 18];

/** True when a font size is a role (a role token, `1em`, a keyword, or a length of 12, 13, 14, or 18 px outside @k2b/ui). */
export const sizeOnScale = (raw: string, { literals }: { literals: boolean }): boolean => {
  const value = raw.replace(/!important/gi, "").trim();
  if (keyword.test(value) || roleToken.test(value) || /^(?:0|1em|100%)$/.test(value)) return true;
  const variable = value.match(/^var\(\s*(--[\w-]+)\s*(?:,(.*))?\)$/s);
  if (variable) return /font-size/.test(variable[1]!) && (variable[2] === undefined || sizeOnScale(variable[2], { literals }));
  const px = pixels(value);
  return literals && px !== undefined && ROLE_PIXELS.includes(px);
};

/** Reading text adds headings in 16 px and sizes relative to its text (em, %). */
const READING_PIXELS = [...ROLE_PIXELS, 16];
export const readingSize = (raw: string): boolean => {
  const value = raw.replace(/!important/gi, "").trim();
  if (/^\d*\.?\d+(?:em|%)$/.test(value) || sizeOnScale(value, { literals: true })) return true;
  const px = pixels(value);
  return px !== undefined && READING_PIXELS.includes(px);
};

export const weightOnScale = (raw: string): boolean => {
  const value = raw.replace(/!important/gi, "").trim();
  if (keyword.test(value) || /^(?:normal|400|500|600)$/.test(value)) return true;
  const variable = value.match(/^var\(\s*(--[\w-]+)\s*(?:,(.*))?\)$/s);
  return variable !== null && (variable[2] === undefined || weightOnScale(variable[2]));
};

/** Reading text: Markdown, the rich-text and code editors. Its headings and code may size in em. */
const readingSelector =
  /k2b-content-markdown|k2b-content-doc-|ProseMirror|k2b-text-editor|k2b-ste-|k2b-markdown|k2b-prose|\.cm-|\.prose\b|data-reading/;
/** The last compound of a selector names a sign: an icon, an avatar or its initials, an emoji, a logo. */
const signCompound =
  /^(?:i|svg)(?![\w-])|\.ti(?![\w-])|icon|glyph|avatar|initials|monogram|emoji|logo|spinner|chevron|caret|checkbox|check__control|[_-]mark(?![\w-])|__arrow(?![\w-])|__tile(?![\w-])|__check(?![\w-])|__marker|__handle|__visual|__info(?![\w-])|media-play|__sign(?![\w-])/;

/** Splits at top-level commas or combinators; brackets and parentheses stay whole. */
const splitTop = (text: string, separators: RegExp): string[] => {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth -= 1;
    if (depth === 0 && separators.test(char)) {
      if (current.trim()) out.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
};

const lastCompound = (selector: string) => splitTop(selector, /[\s>+~]/).at(-1) ?? "";

/** Every selector of a rule targets a sign. */
export const signsOnly = (selectorList: string): boolean => {
  const selectors = splitTop(selectorList, /,/);
  return (
    selectors.length > 0 && selectors.every((selector) => signCompound.test(lastCompound(selector).replace(/::?(?:before|after)$/, "")))
  );
};

export const isReading = (selectors: readonly string[]): boolean => selectors.some((selector) => readingSelector.test(selector));

const allowMarker = /type-scale:\s*allow\s+\S/;
const allowedAt = (lines: readonly string[], line: number): boolean =>
  allowMarker.test(lines[line - 1] ?? "") || allowMarker.test(lines[line - 2] ?? "");

const blankComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;

export type TypeFinding = KeyedFinding & { kind: "size" | "weight"; value: string; selector?: string };

/** The size in a `font` shorthand: the length before an optional `/line-height`. */
const shorthandSize = (value: string): string | undefined => {
  if (keyword.test(value.trim()) || /^var\(/.test(value.trim())) return undefined;
  const match = value.match(/(?:^|\s)((?:\d*\.?\d+)(?:px|rem|em|%)|var\([^)]*\))(?:\s*\/\s*\S+)?\s+["'\w-]/);
  return match?.[1];
};

const tailwindSizes = /^(?:meta|row|body|lead|xs|sm)$/;
const tailwindWeights = /^(?:normal|medium|semibold)$/;
/** A Tailwind size or weight utility with any variants: `md:text-[11px]`, `!font-bold`. */
const textUtility =
  /(?<![\w-])(?:[\w-]+(?:\/[\w-]+)?:)*!?text-(\[[^\]\s]+\]|(?:\d?xl|base|lg|xs|sm|meta|row|body|lead)(?![\w-]))(?:\/[\w.[\]-]+)?/g;
const weightUtility =
  /(?<![\w-])(?:[\w-]+(?:\/[\w-]+)?:)*!?font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)(?![\w-])/g;

/** An arbitrary `text-[…]` is a size only when it holds a length or a size token, not a colour. */
const arbitrarySize = (inner: string): string | undefined => {
  const value = inner.replace(/^length:/, "");
  if (/^(?:\d*\.?\d+)(?:px|rem|em)$/.test(value) || /^var\(--[\w-]*font-size[\w-]*\)$/.test(value)) return value;
  return undefined;
};

/** Off-role size and weight utilities in one class list, with their offset in it. */
const utilityFindings = (text: string, inUi: boolean, reading = false): { kind: "size" | "weight"; utility: string; index: number }[] => {
  const out: { kind: "size" | "weight"; utility: string; index: number }[] = [];
  for (const utility of text.matchAll(textUtility)) {
    const size = utility[1]!;
    const index = utility.index ?? 0;
    if (size.startsWith("[")) {
      const length = arbitrarySize(size.slice(1, -1));
      const ok = length === undefined || sizeOnScale(length, { literals: !inUi }) || (reading && readingSize(length));
      if (!ok) out.push({ kind: "size", utility: utility[0], index });
    } else if (!tailwindSizes.test(size) && !(reading && size === "base")) out.push({ kind: "size", utility: utility[0], index });
  }
  for (const utility of text.matchAll(weightUtility))
    if (!tailwindWeights.test(utility[1]!)) out.push({ kind: "weight", utility: utility[0], index: utility.index ?? 0 });
  return out;
};

export const cssFindings = (workspaceRoot: string, file: string, original: string): TypeFinding[] => {
  const path = relative(workspaceRoot, file);
  const inUi = path.startsWith(UI_SOURCE);
  // The base stylesheet styles documents written as HTML (reports, printed pages), not the controls of an app.
  if (path.startsWith(`${UI_SOURCE}base/`)) return [];
  const lines = original.split("\n");
  const source = blankComments(original);
  const findings: TypeFinding[] = [];
  const stack: string[] = [];
  let buffer = "";
  let start = 0;
  const declaration = (text: string, index: number) => {
    const apply = text.match(/^\s*@apply\s+([\s\S]+?)\s*$/);
    if (apply) {
      const at = index + (text.length - text.trimStart().length);
      if (allowedAt(lines, lineOf(source, at)) || signsOnly(stack.at(-1) ?? "")) return;
      for (const finding of utilityFindings(apply[1]!, inUi, isReading(stack))) {
        const shown = finding.utility;
        findings.push({
          file,
          line: lineOf(source, at),
          kind: finding.kind,
          value: shown,
          selector: stack.at(-1),
          key: `${path} | ${finding.kind} | ${shown}`,
          message: `@apply ${shown}: ${finding.kind === "size" ? sizeMessage : weightMessage}`,
        });
      }
      return;
    }
    const match = text.match(/^\s*([\w-]+)\s*:\s*([\s\S]+?)\s*$/);
    if (!match) return;
    const property = match[1]!.toLowerCase();
    const value = match[2]!.replace(/\s+/g, " ");
    const at = index + (text.length - text.trimStart().length);
    const line = lineOf(source, at);
    const selector = stack.at(-1) ?? "";
    // Print output and the 16 px floor that keeps iOS from zooming into a focused field (coarse pointers only).
    const printed = stack.some((part) => /^@media\b.*\bprint\b/.test(part));
    const touchFloor =
      stack.some((part) => /^@media\b.*pointer:\s*coarse/.test(part)) &&
      /^(?:max\(1rem, ?16px\)|16px|1rem)$/.test(value.replace(/!important/gi, "").trim());
    const exempt = () => printed || touchFloor || signsOnly(selector) || allowedAt(lines, line);
    const add = (kind: "size" | "weight", shown: string) =>
      findings.push({
        file,
        line,
        kind,
        value: shown,
        selector,
        key: `${path} | ${kind} | ${shown}`,
        message: `font-${kind} ${shown} in ${selector || "a custom property"}: ${kind === "size" ? sizeMessage : weightMessage}`,
      });
    const reading = isReading(stack);
    const sizeOk = (size: string) => sizeOnScale(size, { literals: !inUi }) || (reading && readingSize(size));
    if (property === "font-size" || (property.startsWith("--") && /font-size/.test(property))) {
      if (property.startsWith("--k2b-font-size-") && /^--k2b-font-size-(?:meta|row|body|lead)$/.test(property) && inUi) return;
      if (!sizeOk(value) && !exempt()) add("size", value);
    } else if (property === "font") {
      const size = shorthandSize(value);
      if (size !== undefined && !sizeOk(size) && !exempt()) add("size", size);
      const weight = value.match(/(?:^|\s)(bold|bolder|lighter|[1-9]00)(?=\s)/)?.[1];
      if (weight && !weightOnScale(weight) && !exempt()) add("weight", weight);
    } else if (property === "font-weight" || (property.startsWith("--") && /font-weight/.test(property))) {
      if (property.startsWith("--k2b-font-weight-") && inUi) return;
      if (!weightOnScale(value) && !exempt()) add("weight", value);
    }
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (char === "{") {
      stack.push(buffer.trim().replace(/\s+/g, " "));
      buffer = "";
      start = index + 1;
    } else if (char === "}") {
      declaration(buffer, start);
      stack.pop();
      buffer = "";
      start = index + 1;
    } else if (char === ";") {
      declaration(buffer, start);
      buffer = "";
      start = index + 1;
    } else buffer += char;
  }
  return findings;
};

export const tsxFindings = (workspaceRoot: string, file: string, original: string): TypeFinding[] => {
  const path = relative(workspaceRoot, file);
  const inUi = path.startsWith(UI_SOURCE);
  const findings: TypeFinding[] = [];
  const lines = original.split("\n");
  const source = original.replace(/^[ \t]*(?:\/\/|\/\*|\*).*$/gm, (line) => " ".repeat(line.length));
  const add = (index: number, kind: "size" | "weight", value: string) => {
    const line = lineOf(original, index);
    if (allowedAt(lines, line)) return;
    findings.push({
      file,
      line,
      kind,
      value,
      key: `${path} | ${kind} | ${value}`,
      message: `${kind === "size" ? "text size" : "font weight"} ${value}: ${kind === "size" ? sizeMessage : weightMessage}`,
    });
  };
  for (const literal of source.matchAll(/(["'])((?:(?!\1)[^\\\n]|\\.)*)\1|`((?:[^\\`]|\\.)*)`/g)) {
    const text = literal[2] ?? literal[3] ?? "";
    const offset = (literal.index ?? 0) + 1;
    for (const finding of utilityFindings(text, inUi)) add(offset + finding.index, finding.kind, finding.utility);
    for (const style of text.matchAll(/font-size\s*:\s*([^;}\n"'`]+)/g))
      if (!sizeOnScale(style[1]!.trim(), { literals: !inUi })) add(offset + (style.index ?? 0), "size", style[1]!.trim());
  }
  // Style objects: `fontSize: "11px"` and Solid's `"font-size": "11px"`.
  for (const style of source.matchAll(/(?:\bfontSize|(["'])font-size\1)\s*:\s*(["'`])([^"'`]*)\2/g))
    if (!sizeOnScale(style[3]!.trim(), { literals: !inUi })) add(style.index ?? 0, "size", style[3]!.trim());
  for (const style of source.matchAll(/(?:\bfontWeight|(["'])font-weight\1)\s*:\s*(?:(["'`])([^"'`]*)\2|(\d+))/g)) {
    const value = (style[3] ?? style[4] ?? "").trim();
    if (!weightOnScale(value)) add(style.index ?? 0, "weight", value);
  }
  return findings;
};

export const collectTypeFindings = (workspaceRoot: string): TypeFinding[] =>
  workspacePackages(workspaceRoot)
    .flatMap((pkg) => listFiles(join(workspaceRoot, pkg, "src"), /\.(?:tsx|css)$/))
    .filter((file) => !isTestFile(file) && !/browser-harness|browser-suite|browser-fixture|\.fixture\./.test(file))
    .sort()
    .flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return file.endsWith(".css") ? cssFindings(workspaceRoot, file, source) : tsxFindings(workspaceRoot, file, source);
    });

export const rule: Rule = {
  name: RULE,
  description: "Text uses the four type roles (12, 13, 14, 18 px) and weights 400–600 (K11); @k2b/ui strictly, apps with a baseline",
  run: async ({ workspaceRoot, fix }) => {
    const findings = collectTypeFindings(workspaceRoot);
    // @k2b/ui is the owner of the roles: none of its findings can be known debt.
    const ui = findings.filter((finding) => relative(workspaceRoot, finding.file).startsWith(UI_SOURCE));
    const apps = findings.filter((finding) => !relative(workspaceRoot, finding.file).startsWith(UI_SOURCE));
    const strict: Finding[] = ui.map(({ file, line, message }) => ({ file, line, message }));
    return [...strict, ...compareBaseline(workspaceRoot, RULE, HEADER, apps, fix)];
  },
};
