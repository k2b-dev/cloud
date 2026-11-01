import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { listFiles } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * Blink keeps one invalidation set for all of `:has()`. A selector whose `:has()` is followed by a last part that
 * names no class, id, attribute or element (`:has(a) *`, `:has(a) > :not(.b)`, `:has(a) > :nth-child(1)`) makes
 * that set cover the whole subtree, so any `:has()` change anywhere restyles the document from its root. One such
 * rule costs a mailbox with 10,000 elements 200 ms per DOM change, in every app that loads the stylesheet.
 */
/** Files this rule does not read: a standalone stylesheet for plain pages, and rules active only while printing. */
const EXEMPT_FILES = new Set(["packages/ui/src/base/base.css", "packages/ui/src/styles/print.css"]);
/** Known debt, each with an issue: `file:selector start`. */
const KNOWN = new Set([
  "packages/notebooks/src/styles/app.css:.notebook-book-content:not(.cm-query-block-preview):has(> figure.notebook-map",
]);

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

/** Each style rule's selector with its line, leaving out comments and at-rule headers. */
export const cssSelectors = (source: string): { selector: string; line: number }[] => {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const found: { selector: string; line: number }[] = [];
  let start = 0;
  for (let index = 0; index < clean.length; index++) {
    const char = clean[index];
    if (char === ";" || char === "}") start = index + 1;
    if (char !== "{") continue;
    const prelude = clean.slice(start, index);
    start = index + 1;
    const selector = prelude.trim();
    if (!selector || selector.startsWith("@")) continue;
    const offset = prelude.length - prelude.trimStart().length;
    found.push({ selector, line: clean.slice(0, start - prelude.length - 1 + offset).split("\n").length });
  }
  return found;
};

const MESSAGE =
  "`:has()` before a last part that names no class, id, attribute or element restyles the whole document on every `:has()` change. Name the part, or move the value into a custom property set on a named element.";

export const rule: Rule = {
  name: "css-has-scope",
  description: "`:has()` is never followed by an unnamed last selector part, which restyles the whole document",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    const root = join(workspaceRoot, "packages");
    for (const file of listFiles(root, /\.css$/)) {
      const path = relative(workspaceRoot, file);
      if (EXEMPT_FILES.has(path)) continue;
      for (const { selector, line } of cssSelectors(readFileSync(file, "utf8"))) {
        if (!hasBeforeUnnamedSubject(selector)) continue;
        if ([...KNOWN].some((known) => `${path}:${selector}`.startsWith(known))) continue;
        findings.push({ file: path, line, message: MESSAGE });
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
