import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { TYPE_LINE_HEIGHTS, TYPE_SIZES, TYPE_WEIGHTS } from "../fixtures/type-roles";
import { workspacePackages } from "../workspace";
import { compareBaseline, type KeyedFinding } from "./baseline";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * K11 of Cloud flach: text uses the four type roles of `scripts/fixtures/type-roles.ts`, which reads them from their
 * tokens in `packages/ui/src/styles/index.css`. One rule per property:
 *
 * - `font-size` is a role token (`var(--k2b-font-size-*)`), `inherit`, `1em`, or `0`; outside @k2b/ui also a role size;
 * - `line-height` is a role token (`var(--k2b-line-height-*)`), `inherit`, or one of the roles' line heights;
 * - `font-weight` is 400, 500, 600, `normal`, or a weight token.
 *
 * A custom property named after its property (`*font-size*`, `*line-height*`, `*weight*`) follows the same rule, and a
 * `var()` of another name fails. Signs (`i`, `svg`, `.ti`, avatars, emoji) and print output are not text; reading text
 * (`.k2b-content-markdown`, `.k2b-ste-formatted`, `.ProseMirror`) adds 16 px headings and em or unitless leading; a
 * focused field under `pointer: coarse` keeps the 16 px that stops iOS zooming. Anything else names its reason on its
 * line or the line above, `type-scale: allow <reason>`, and every such allowance is a line in the baseline, so a new one
 * is a reviewed change. In TSX the same holds for Tailwind (`text-*`, `leading-*`, `font-*`) and style objects.
 * @k2b/ui has no findings; the apps' findings are baseline lines that only shrink.
 */
const RULE = "type-scale";
const HEADER = [
  "Known text sizes, line heights, and weights outside the four type roles (K11), and every `type-scale: allow`, one",
  "per occurrence: <file> | <size|line|weight|allow> | <value>. Lanes remove lines as they migrate; the rule never adds",
  "lines. `bun scripts/check.ts type-scale --fix` removes lines whose finding is gone. Only allowances name @k2b/ui.",
];
const sizeMessage =
  "use a type role: var(--k2b-font-size-meta|row|body|lead) in CSS, text-meta|row|body|lead in classes (12, 13, 14, 18 px); see /en/ui/surfaces/utilities#type-roles (K11)";
const weightMessage =
  "use weight 400, 500, or 600 (font-normal, font-medium, font-semibold); see /en/ui/surfaces/utilities#type-roles (K11)";
const lineMessage =
  "use a role line height: var(--k2b-line-height-meta|row|body|lead) in CSS, leading-4|5|6 in classes; see /en/ui/surfaces/utilities#type-roles (K11)";
type Kind = "size" | "line" | "weight" | "allow";
const messages: Record<Kind, string> = { size: sizeMessage, line: lineMessage, weight: weightMessage, allow: "" };

const UI_SOURCE = "packages/ui/src/";
const keyword = /^(?:inherit|initial|unset|revert|revert-layer)$/i;
const roleToken = /^var\(\s*--k2b-font-size-(?:meta|row|body|lead)\s*\)$/;
const lineToken = /^var\(\s*--k2b-line-height-(?:meta|row|body|lead)\s*\)$/;

/** A length in px; `rem` counts 16 px. Undefined when the value is not a plain length. */
const pixels = (value: string): number | undefined => {
  const match = value.match(/^(\d*\.?\d+)(px|rem)$/);
  if (!match) return undefined;
  return Number.parseFloat(match[1]!) * (match[2] === "rem" ? 16 : 1);
};
const ROLE_PIXELS = TYPE_SIZES;

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

/** True when a line height is a role's: a token, `inherit`, or a length the roles take (16, 20, 22, 24 px). */
export const lineOnScale = (raw: string): boolean => {
  const value = raw.replace(/!important/gi, "").trim();
  if (keyword.test(value) || lineToken.test(value)) return true;
  const variable = value.match(/^var\(\s*(--[\w-]+)\s*(?:,(.*))?\)$/s);
  if (variable) return /line-height/.test(variable[1]!) && (variable[2] === undefined || lineOnScale(variable[2]));
  const px = pixels(value);
  return px !== undefined && TYPE_LINE_HEIGHTS.includes(px);
};
/** Reading text sets its leading relative to its text, too. */
const readingLine = (raw: string) => lineOnScale(raw) || /^\d*\.?\d+(?:em|%)?$/.test(raw.replace(/!important/gi, "").trim());
export const readingSize = (raw: string): boolean => {
  const value = raw.replace(/!important/gi, "").trim();
  if (/^\d*\.?\d+(?:em|%)$/.test(value) || sizeOnScale(value, { literals: true })) return true;
  const px = pixels(value);
  return px !== undefined && READING_PIXELS.includes(px);
};

export const weightOnScale = (raw: string): boolean => {
  const value = raw.replace(/!important/gi, "").trim();
  if (keyword.test(value) || value === "normal" || TYPE_WEIGHTS.includes(Number(value))) return true;
  const variable = value.match(/^var\(\s*(--[\w-]+)\s*(?:,(.*))?\)$/s);
  return variable !== null && /weight/.test(variable[1]!) && (variable[2] === undefined || weightOnScale(variable[2]));
};

/**
 * Reading text is the content of three containers only: rendered Markdown (`.k2b-content-markdown`), the shared text
 * editor's formatted text (`.k2b-ste-formatted`), and a ProseMirror document. It adds headings in 16 px and sizes in em
 * or % of its text; an editor's toolbars, menus, and labels are controls and use the roles.
 */
const readingSelector = /\.k2b-content-markdown\b|\.k2b-ste-formatted\b|\.ProseMirror\b/;
/** A sign is an `i` or `svg` element, a Tabler `.ti`, an avatar, or an emoji; any other sign names itself with `type-scale: allow`. */
const signCompound = /^(?:i|svg)(?![\w-])|\.ti(?![\w-])|avatar|emoji/;

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
const allowReason = /type-scale:\s*allow\s+(.+?)\s*(?:\*\/|$)/;

/** Every `type-scale: allow <reason>` in a file, as baseline findings, so each allowance is pinned and reviewed. */
const allowFindings = (workspaceRoot: string, file: string, original: string): TypeFinding[] => {
  const path = relative(workspaceRoot, file);
  return original.split("\n").flatMap((text, index) => {
    const reason = text.match(allowReason)?.[1];
    if (!reason) return [];
    return [
      {
        file,
        line: index + 1,
        kind: "allow" as const,
        value: reason,
        key: `${path} | allow | ${reason}`,
        message: `type-scale: allow ${reason}: a new allowance is a baseline line; prefer a type role`,
      },
    ];
  });
};
const allowedAt = (lines: readonly string[], line: number): boolean =>
  allowMarker.test(lines[line - 1] ?? "") || allowMarker.test(lines[line - 2] ?? "");

const blankComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;

export type TypeFinding = KeyedFinding & { kind: Kind; value: string; selector?: string };

/** The size and line height in a `font` shorthand: the length before an optional `/line-height`. */
const shorthand = (value: string): { size?: string; line?: string } => {
  if (keyword.test(value.trim()) || /^var\(/.test(value.trim())) return {};
  const match = value.match(/(?:^|\s)((?:\d*\.?\d+)(?:px|rem|em|%)|var\([^)]*\))(?:\s*\/\s*((?:var\([^)]*\))|[^\s/]+))?\s+["'\w-]/);
  return { size: match?.[1], line: match?.[2] };
};

const tailwindSizes = /^(?:meta|row|body|lead|xs|sm)$/;
/** `leading-4|5|6` are 16, 20, 24 px; `leading-[…]` passes when its length does. */
const leadingUtility = /(?<![\w-])(?:[\w-]+(?:\/[\w-]+)?:)*!?leading-(\[[^\]\s]+\]|[\w.]+)(?![\w-])/g;
const leadingOk = (value: string) =>
  value.startsWith("[") ? lineOnScale(value.slice(1, -1).replace(/^length:/, "")) : /^(?:4|5|6)$/.test(value);
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
const utilityFindings = (text: string, inUi: boolean, reading = false): { kind: Kind; utility: string; index: number }[] => {
  const out: { kind: Kind; utility: string; index: number }[] = [];
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
  if (!reading)
    for (const utility of text.matchAll(leadingUtility))
      if (!leadingOk(utility[1]!)) out.push({ kind: "line", utility: utility[0], index: utility.index ?? 0 });
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
          message: `@apply ${shown}: ${messages[finding.kind]}`,
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
    const add = (kind: Kind, shown: string) =>
      findings.push({
        file,
        line,
        kind,
        value: shown,
        selector,
        key: `${path} | ${kind} | ${shown}`,
        message: `${kind === "line" ? "line-height" : `font-${kind}`} ${shown} in ${selector || "a custom property"}: ${messages[kind]}`,
      });
    const reading = isReading(stack);
    const sizeOk = (size: string) => sizeOnScale(size, { literals: !inUi }) || (reading && readingSize(size));
    if (property === "font-size" || (property.startsWith("--") && /font-size/.test(property))) {
      if (property.startsWith("--k2b-font-size-") && /^--k2b-font-size-(?:meta|row|body|lead)$/.test(property) && inUi) return;
      if (!sizeOk(value) && !exempt()) add("size", value);
    } else if (property === "font") {
      const { size, line: lineHeight } = shorthand(value);
      if (size !== undefined && !sizeOk(size) && !exempt()) add("size", size);
      if (lineHeight !== undefined && !(reading ? readingLine(lineHeight) : lineOnScale(lineHeight)) && !exempt()) add("line", lineHeight);
      const weight = value.match(/(?:^|\s)(bold|bolder|lighter|[1-9]00)(?=\s)/)?.[1];
      if (weight && !weightOnScale(weight) && !exempt()) add("weight", weight);
    } else if (property === "line-height" || (property.startsWith("--") && /line-height/.test(property))) {
      if (/^--k2b-line-height-(?:meta|row|body|lead)$/.test(property) && inUi) return;
      if (!(reading ? readingLine(value) : lineOnScale(value)) && !exempt()) add("line", value);
    } else if (property === "font-weight" || (property.startsWith("--") && /weight/.test(property))) {
      if (/^--k2b-font-weight-(?:meta|row|body|lead)$/.test(property) && inUi) return;
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
  const add = (index: number, kind: Kind, value: string) => {
    const line = lineOf(original, index);
    if (allowedAt(lines, line)) return;
    findings.push({ file, line, kind, value, key: `${path} | ${kind} | ${value}`, message: `${kind} ${value}: ${messages[kind]}` });
  };
  for (const literal of source.matchAll(/(["'])((?:(?!\1)[^\\\n]|\\.)*)\1|`((?:[^\\`]|\\.)*)`/g)) {
    const text = literal[2] ?? literal[3] ?? "";
    const offset = (literal.index ?? 0) + 1;
    for (const finding of utilityFindings(text, inUi)) add(offset + finding.index, finding.kind, finding.utility);
    for (const style of text.matchAll(/font-size\s*:\s*([^;}\n"'`]+)/g))
      if (!sizeOnScale(style[1]!.trim(), { literals: !inUi })) add(offset + (style.index ?? 0), "size", style[1]!.trim());
    for (const style of text.matchAll(/line-height\s*:\s*([^;}\n"'`]+)/g))
      if (!lineOnScale(style[1]!.trim())) add(offset + (style.index ?? 0), "line", style[1]!.trim());
  }
  // Style objects: `fontSize: "11px"`, `fontSize: 11` (px), and Solid's `"font-size": "11px"`.
  for (const style of source.matchAll(/(?:\bfontSize|(["'])font-size\1)\s*:\s*(?:(["'`])([^"'`]*)\2|(\d+(?:\.\d+)?)\b)/g)) {
    const value = style[3] !== undefined ? style[3].trim() : `${style[4]}px`;
    if (!sizeOnScale(value, { literals: !inUi })) add(style.index ?? 0, "size", value);
  }
  for (const style of source.matchAll(/(?:\blineHeight|(["'])line-height\1)\s*:\s*(?:(["'`])([^"'`]*)\2|(\d+(?:\.\d+)?)\b)/g)) {
    const value = style[3] !== undefined ? style[3].trim() : (style[4] ?? "");
    if (!lineOnScale(value)) add(style.index ?? 0, "line", value);
  }
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
      return [
        ...(file.endsWith(".css") ? cssFindings(workspaceRoot, file, source) : tsxFindings(workspaceRoot, file, source)),
        ...allowFindings(workspaceRoot, file, source),
      ];
    });

export const rule: Rule = {
  name: RULE,
  description:
    "Text uses the four type roles: size, line height, and weight (K11); @k2b/ui strictly, apps and every allowance in a baseline",
  run: async ({ workspaceRoot, fix }) => {
    const findings = collectTypeFindings(workspaceRoot);
    // @k2b/ui is the owner of the roles: none of its findings can be known debt, only its named allowances.
    const strictUi = (finding: TypeFinding) => relative(workspaceRoot, finding.file).startsWith(UI_SOURCE) && finding.kind !== "allow";
    const ui = findings.filter(strictUi);
    const apps = findings.filter((finding) => !strictUi(finding));
    const strict: Finding[] = ui.map(({ file, line, message }) => ({ file, line, message }));
    return [...strict, ...compareBaseline(workspaceRoot, RULE, HEADER, apps, fix)];
  },
};
