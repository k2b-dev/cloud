import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { listFiles } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * Blink keeps one invalidation set for all of `:has()`: the parts after every `:has()` that is not on the styled
 * element itself (`.a:has(.b) .c` adds `.c`). A `:not()` or a state pseudo-class in any `:has()` argument makes every
 * DOM change check `:has()`, and the check restyles the elements that match the set below each anchor it reaches.
 * Three shapes turn that into a pass over the whole page:
 *
 * - a last part that names no class, id, attribute or element (`:has(a) *`, `:has(a) > :not(.b)`): the set covers
 *   the whole subtree;
 * - an anchor that holds the page (the document, `body`, the shell, a workspace) with an argument that reaches any
 *   depth (`html:has(.a) .b`): every change below it reaches the anchor, so it restyles all of the set in the page;
 * - a last part that the page holds many times (`.k2b-button`, `button`, `i`): every change restyles each of them.
 *
 * One such rule costs a mailbox with 10,000 elements 200 ms per DOM change, in every app that loads the stylesheet
 * (#2420, #2492). The state belongs on an attribute that its owner sets (`data-k2b-own-title`, `aria-busy`), or the
 * `:has()` moves onto the element it styles.
 */
/** Files this rule does not read: a standalone stylesheet for plain pages, and rules active only while printing. */
const EXEMPT_FILES = new Set(["packages/ui/src/base/base.css", "packages/ui/src/styles/print.css"]);
/** Known debt, each with an issue: `file:selector start`. */
const KNOWN = new Set([
  "packages/notebooks/src/styles/app.css:.notebook-book-content:not(.cm-query-block-preview):has(> figure.notebook-map",
]);
/** Known debt of the anchor and repeated-part shapes, each with an issue: `file:selector start` after nesting. */
const KNOWN_PAGE_WIDE = new Set([
  // #2493: the address editor's workspace layout.
  "packages/contacts/src/styles/app.css:.k2b-app-workspace:has(.contacts-address-editor",
  "packages/contacts/src/styles/app.css::is(.k2b-ui .k2b-app-workspace:has(> #contacts-book-navigation):has(.contacts-address-editor",
  "packages/contacts/src/styles/app.css::is(:is(.k2b-ui .k2b-app-workspace:has(> #contacts-book-navigation):has(.contacts-address-editor",
  // #2493: the phone head while searching or selecting.
  "packages/mail/src/styles/app.css:.k2b-ui .mail-workspace > .k2b-app-workspace__head:has([data-mail-head-search], [data-mail-head-selection]) .k2b-app-workspace__head-actions >",
  // #2493: the navigation spinner's icon.
  "packages/filesv2/src/styles/app.css:.k2b-app-workspace__nav-tree-row:has(.filesv2-nav-spinner) > .k2b-app-workspace__sidebar-item-icon i",
]);

/** Elements that hold the page's content. A `:has()` on one of them that reaches any depth sees every change. */
const PAGE_ANCHOR =
  /^(?:html|body|:root|\.k2b-ui|\.cloud-app-canvas|\.layout-shell-content|\.layout-content-main|\.k2b-app-workspace(?:__content|__main)?|\.k2b-mobile-shell(?:__main)?|\.app-workspace|\.workspace-content)(?![\w-])/;
/** Parts a page holds many times: shared controls and the tags of ordinary content. */
const REPEATED_CLASS = /\.(?:k2b-button|k2b-button__label|k2b-icon-button|k2b-ui|ti)(?![\w-])/;
const REPEATED_TAG = /^(?:a|button|i|span|div|p|li|ul|ol|input|svg|img|code|strong|small|label|td|tr|th)(?![\w-])/;

const TAILWIND_HAS_VARIANT = /\b(?:group|peer)-has-\[/;

const splitTopLevel = (text: string, separator: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(" || char === "[") depth++;
    if (char === ")" || char === "]") depth--;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts;
};

/** The compounds of one selector, without its combinators. */
const compounds = (selector: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of selector.trim()) {
    if (char === "(" || char === "[") depth++;
    if (char === ")" || char === "]") depth--;
    if (depth === 0 && /[\s>+~]/.test(char)) {
      if (current) parts.push(current);
      current = "";
    } else current += char;
  }
  if (current) parts.push(current);
  return parts;
};

/** Arguments of `:is()` and `:where()`, which name what their compound is. */
const matchesArguments = (compound: string): string[] => {
  const found: string[] = [];
  for (const match of compound.matchAll(/:(?:is|where|-webkit-any)\(/g)) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < compound.length && depth > 0) {
      if (compound[index] === "(") depth++;
      if (compound[index] === ")") depth--;
      index++;
    }
    found.push(compound.slice(start, index - 1));
  }
  return found;
};

const withoutFunctions = (compound: string): string => {
  let depth = 0;
  let plain = "";
  for (const char of compound) {
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (depth === 0) plain += char;
  }
  return plain;
};

/** Whether a compound names a class, id, attribute or element, directly or through every `:is()` argument. */
const namesSomething = (compound: string): boolean => {
  const plain = withoutFunctions(compound).replace(/::?[a-z-]+/g, "");
  if (/[.#[]/.test(plain) || /^[a-zA-Z]/.test(plain)) return true;
  return matchesArguments(compound).some((list) =>
    splitTopLevel(list, ",").every((selector) => {
      const last = compounds(selector).at(-1);
      return last !== undefined && namesSomething(last);
    }),
  );
};

/** Whether a selector, or a selector inside its `:is()`, `:where()` or `:not()`, has this shape. */
export const hasBeforeUnnamedSubject = (selector: string): boolean =>
  splitTopLevel(selector, ",").some((single) => {
    const parts = compounds(single);
    const last = parts.at(-1);
    if (last && parts.length > 1 && parts.slice(0, -1).some((part) => part.includes(":has(")) && !namesSomething(last)) return true;
    return parts.some((part) => matchesArguments(part).some(hasBeforeUnnamedSubject));
  });

/** The compound that holds the character before `end`, also inside `:is()` or another `:has()`. */
const compoundBefore = (text: string, end: number): string => {
  let depth = 0;
  let start = end;
  while (start > 0) {
    const char = text[start - 1]!;
    if (char === ")" || char === "]") depth++;
    else if (char === "(" || char === "[") {
      if (depth > 0) depth--;
      // `:not(:has())` and `:is(:has())` ask about the element of the compound around them.
      else if (start === end && /:(?:not|is|where)$/.test(text.slice(0, start - 1)))
        start -= text.slice(0, start - 1).match(/:(?:not|is|where)$/)![0].length;
      else break;
    } else if (depth === 0 && /[\s,>+~]/.test(char)) break;
    start--;
  }
  return text.slice(start, end);
};

/** Each `:has()` in a compound: the compound it sits on, and its arguments. */
const hasArguments = (compound: string): { anchor: string; arguments: string[] }[] => {
  const found: { anchor: string; arguments: string[] }[] = [];
  for (const match of compound.matchAll(/:has\(/g)) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < compound.length && depth > 0) {
      if (compound[index] === "(") depth++;
      if (compound[index] === ")") depth--;
      index++;
    }
    found.push({ anchor: compoundBefore(compound, match.index), arguments: splitTopLevel(compound.slice(start, index - 1), ",") });
  }
  return found;
};

/** Whether a relative selector reaches any depth: it starts at descendants or has a descendant combinator. */
const reachesAnyDepth = (relative: string): boolean => {
  const trimmed = relative.trim().replace(/\s*([>+~])\s*/g, "$1");
  if (!/^[>+~]/.test(trimmed)) return true;
  let depth = 0;
  for (const char of trimmed) {
    if (char === "(" || char === "[") depth++;
    if (char === ")" || char === "]") depth--;
    if (depth === 0 && char === " ") return true;
  }
  return false;
};

/**
 * Each `:has()` that is not on the element its selector styles, with the subject that follows it. A `:has()` inside
 * `:is()`, `:where()` or `:not()` counts within that argument; an earlier compound's argument styles nothing itself.
 */
const nonSubjectHas = (selector: string): { anchor: string; arguments: string[]; subject: string }[] =>
  splitTopLevel(selector, ",").flatMap((single) => {
    const parts = compounds(single);
    const subject = parts.at(-1) ?? "";
    const found = parts.slice(0, -1).flatMap((part) => hasArguments(part).map((has) => ({ ...has, subject })));
    for (const part of parts) for (const list of matchesArguments(part)) found.push(...nonSubjectHas(list));
    return found;
  });

/** The compounds a subject can match: itself, or each last compound of its `:is()` arguments. */
const subjectCompounds = (subject: string): string[] => {
  const lists = matchesArguments(subject);
  const own = withoutFunctions(subject);
  if (!lists.length || own.replace(/::?[a-z-]+/g, "").trim()) return [subject];
  return lists.flatMap((list) => splitTopLevel(list, ",").map((selector) => compounds(selector).at(-1) ?? ""));
};

/** Why a selector restyles the whole page on every DOM change, if it does. */
export const pageWideHas = (selector: string): "anchor" | "repeated" | undefined => {
  const found = nonSubjectHas(selector);
  // An anchor written as `:is(.layout-shell-content)` (nesting writes it so) names what its arguments name.
  const anchors = (anchor: string): string[] => [anchor, ...subjectCompounds(anchor).filter((compound) => compound !== anchor)];
  if (found.some((has) => anchors(has.anchor).some((name) => PAGE_ANCHOR.test(name)) && has.arguments.some(reachesAnyDepth)))
    return "anchor";
  // What `:not()` excludes is not matched; `:is()` arguments count through `subjectCompounds`.
  const repeated = (compound: string) => {
    const own = withoutFunctions(compound);
    return REPEATED_CLASS.test(own) || (REPEATED_TAG.test(own) && !/[.#[]/.test(own));
  };
  if (found.some((has) => subjectCompounds(has.subject).some(repeated))) return "repeated";
  return undefined;
};

/** Each style rule's selector with its line, leaving out comments and at-rule headers. Nested rules resolve `&`. */
export const cssSelectors = (source: string): { selector: string; line: number }[] => {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const found: { selector: string; line: number }[] = [];
  // The resolved selectors of each open block; at-rules keep their parent's.
  const parents: (string[] | undefined)[] = [];
  let start = 0;
  for (let index = 0; index < clean.length; index++) {
    const char = clean[index];
    if (char === "}") parents.pop();
    if (char === ";" || char === "}") start = index + 1;
    if (char !== "{") continue;
    const prelude = clean.slice(start, index);
    start = index + 1;
    const selector = prelude.trim().replace(/\s+/g, " ");
    const parent = parents.findLast((entry) => entry !== undefined);
    if (!selector || selector.startsWith("@")) {
      parents.push(undefined);
      continue;
    }
    const own = splitTopLevel(selector, ",").map((part) => part.trim());
    // `&` stands for any of the parent's selectors, as `:is()` of all of them.
    const outer = parent && `:is(${parent.join(", ")})`;
    const resolved = outer ? own.map((part) => (part.includes("&") ? part.replaceAll("&", outer) : `${outer} ${part}`)) : own;
    parents.push(resolved);
    const offset = prelude.length - prelude.trimStart().length;
    found.push({ selector: resolved.join(", "), line: clean.slice(0, start - prelude.length - 1 + offset).split("\n").length });
  }
  return found;
};

const MESSAGE =
  "`:has()` before a last part that names no class, id, attribute or element restyles the whole document on every `:has()` change. Name the part, or move the value into a custom property set on a named element.";
const PAGE_WIDE_MESSAGE = {
  anchor:
    "A `:has()` on the document, `body`, the shell or a workspace that reaches any depth restyles the page on every change inside it. Let the owner set an attribute for the state, or ask a smaller element.",
  repeated:
    "A part after a `:has()` that is not on the styled element is restyled in the whole page on every DOM change; this one occurs many times per page. Put the `:has()` on the element it styles, or use an attribute its owner sets.",
};

export const rule: Rule = {
  name: "css-has-scope",
  description: "`:has()` never restyles the whole page on every DOM change: no unnamed or repeated last part, no deep page anchor",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    const root = join(workspaceRoot, "packages");
    for (const file of listFiles(root, /\.css$/)) {
      const path = relative(workspaceRoot, file);
      if (EXEMPT_FILES.has(path)) continue;
      for (const { selector, line } of cssSelectors(readFileSync(file, "utf8"))) {
        const known = (entries: Set<string>) => [...entries].some((entry) => `${path}:${selector}`.startsWith(entry));
        if (hasBeforeUnnamedSubject(selector) && !known(KNOWN)) findings.push({ file: path, line, message: MESSAGE });
        const pageWide = pageWideHas(selector);
        if (pageWide && !known(KNOWN_PAGE_WIDE)) findings.push({ file: path, line, message: PAGE_WIDE_MESSAGE[pageWide] });
      }
    }
    for (const file of listFiles(root, /\.tsx$/)) {
      if (TAILWIND_HAS_VARIANT.test(readFileSync(file, "utf8"))) {
        findings.push({
          file: relative(workspaceRoot, file),
          message: `A Tailwind \`group-has-\` or \`peer-has-\` variant compiles to \`:has() *\`. ${MESSAGE}`,
        });
      }
    }
    return findings;
  },
};
