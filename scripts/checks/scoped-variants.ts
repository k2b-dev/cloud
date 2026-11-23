import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "@typescript/typescript6";
import { __unstable__loadDesignSystem } from "tailwindcss";
import { isTestFile, listFiles, parseSource, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * Shared UI (`@k2b/cloud`, `@k2b/ui`) renders inside every app page. The app page links the app's own `app.css`
 * before `global.css`, but many browser fixtures load it after, and both put their utilities in `@layer utilities`.
 * A class list that pairs a plain utility with a variant on the same property, such as `gap-1 sm:gap-2` or
 * `text-zinc-400 dark:text-zinc-600`, then breaks wherever the app's sheet comes later and repeats the plain
 * utility: at equal specificity the later `gap-1` beats the shared `sm:gap-2`. Shared markup scopes both sides
 * instead (`max-sm:gap-1 sm:gap-2`, `not-dark:text-zinc-400 dark:text-zinc-600`) and looks the same in either order.
 *
 * App markup is out of scope: an app sheet compiles without Cloud's theme and has no breakpoint variants, so only
 * the page order protects it (`define-app.css-order.browser.test.ts`).
 *
 * Which classes collide is read from Cloud's own Tailwind setup (`global.css`): a variant collides with a plain
 * utility when its rule styles the same element at the same specificity (media, container, `dark:`) and sets a
 * property the plain one sets, shorthands included (`p-2` with `md:px-3`). Variants that add specificity (`hover:`,
 * `data-[…]:`, `light:`) or style other elements (`[&>svg]:`, `*:`) do not collide.
 */
const roots = ["packages/cloud/src", "packages/ui/src", "packages/editor/src"];
const globalCss = resolve(import.meta.dir, "../../packages/cloud/src/styles/global.css");

type Specificity = [number, number, number];
type StyleRule = { selector: string; declarations: Map<string, string> };
type Utility = { rules: StyleRule[] };

/** Loads Cloud's Tailwind design system once: its theme, plugins and custom variants decide what a class does. */
let designSystem: Promise<{ candidatesToCss: (candidates: string[]) => (string | null)[] }> | undefined;
const loadDesignSystem = () =>
  (designSystem ??= (async () => {
    const loadStylesheet = async (id: string, base: string) => {
      const path = id.startsWith(".") ? resolve(base, id) : Bun.resolveSync(id === "tailwindcss" ? "tailwindcss/index.css" : id, base);
      return { path, base: dirname(path), content: await Bun.file(path).text() };
    };
    const loadModule = async (id: string, base: string) => {
      const path = Bun.resolveSync(id, base);
      return { path, base: dirname(path), module: (await import(path)).default };
    };
    try {
      return await __unstable__loadDesignSystem(readFileSync(globalCss, "utf8"), { base: dirname(globalCss), loadStylesheet, loadModule });
    } catch (error) {
      throw new Error(
        `scoped-variants reads Cloud's Tailwind setup from global.css; build @k2b/ui first (bun run --cwd packages/ui build)`,
        {
          cause: error,
        },
      );
    }
  })());

/** The style rules of Tailwind's CSS for one class; at-rule conditions are dropped, `@property` blocks skipped. */
const styleRules = (css: string): StyleRule[] => {
  const rules: StyleRule[] = [];
  const parse = (text: string): void => {
    let index = 0;
    while (index < text.length) {
      const open = text.indexOf("{", index);
      if (open < 0) return;
      let depth = 1;
      let close = open + 1;
      for (; close < text.length && depth > 0; close++) {
        if (text[close] === "{") depth++;
        else if (text[close] === "}") depth--;
      }
      const prelude = text.slice(index, open).trim();
      const body = text.slice(open + 1, close - 1);
      if (prelude.startsWith("@")) {
        if (!prelude.startsWith("@property")) parse(body);
      } else {
        const declarations = new Map<string, string>();
        for (const line of body.split(";")) {
          const colon = line.indexOf(":");
          if (colon > 0) declarations.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
        }
        rules.push({ selector: prelude, declarations });
      }
      index = close;
    }
  };
  parse(css);
  return rules;
};

/** Splits at a separator outside brackets, parentheses and quotes, honouring CSS escapes. */
const splitTopLevel = (text: string, isSeparator: (char: string, index: number) => boolean): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\\") {
      index++;
      continue;
    }
    if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (depth === 0 && isSeparator(char, index)) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
};

/** The compounds of a selector, split at its combinators (descendant, `>`, `+`, `~`). */
const compounds = (selector: string): string[] =>
  splitTopLevel(selector.replace(/\s*([>+~])\s*/g, " $1 ").trim(), (char) => char === " ").filter((part) => part && !/^[>+~]$/.test(part));

const functionalPseudo = /^:(is|where|not|has|matches|nth-child|nth-last-child|nth-of-type|nth-last-of-type)\(/;

/** The specificity of one selector, as the cascade counts it (`:where()` 0, `:is()`/`:not()`/`:has()` their highest argument). */
const specificity = (selector: string): Specificity => {
  const total: Specificity = [0, 0, 0];
  const add = (value: Specificity) => value.forEach((part, index) => (total[index as 0 | 1 | 2] += part));
  for (const compound of compounds(selector)) {
    let index = 0;
    while (index < compound.length) {
      const rest = compound.slice(index);
      const functional = functionalPseudo.exec(rest);
      if (functional) {
        let depth = 0;
        let end = index + functional[0].length - 1;
        for (; end < compound.length; end++) {
          if (compound[end] === "\\") end++;
          else if (compound[end] === "(") depth++;
          else if (compound[end] === ")" && --depth === 0) break;
        }
        const argument = compound.slice(index + functional[0].length, end);
        const name = functional[1]!;
        if (["is", "not", "has", "matches"].includes(name)) {
          const highest = splitTopLevel(argument, (char) => char === ",")
            .map((part) => specificity(part.trim()))
            .reduce<Specificity>((best, next) => (compare(next, best) > 0 ? next : best), [0, 0, 0]);
          add(highest);
        } else if (name !== "where") add([0, 1, 0]);
        index = end + 1;
        continue;
      }
      const token = /^(#|\.|\[|::?|\*|[a-zA-Z])((?:\\.|[^.#[:\\])*)/.exec(rest);
      if (!token) {
        index++;
        continue;
      }
      if (token[1] === "[") {
        const end = compound.indexOf("]", index);
        add([0, 1, 0]);
        index = end < 0 ? compound.length : end + 1;
        continue;
      }
      if (token[1] === "#") add([1, 0, 0]);
      else if (token[1] === ".") add([0, 1, 0]);
      else if (token[1] === "::" || /^:(before|after|first-line|first-letter)$/.test(token[0])) add([0, 0, 1]);
      else if (token[1] === ":") add([0, 1, 0]);
      else if (token[1] !== "*") add([0, 0, 1]);
      index += token[0].length;
    }
  }
  return total;
};

const compare = (left: Specificity, right: Specificity): number => left[0] - right[0] || left[1] - right[1] || left[2] - right[2];

/** True when the rule styles the element that carries the class, not a child, sibling or ancestor. */
const stylesItsElement = (selector: string, className: string): boolean => {
  const subject = compounds(selector).at(-1) ?? "";
  if (splitTopLevel(subject, (char) => char === "." || char === ":" || char === "[").includes(className)) return true;
  // `:is(:where(.group):hover .group-hover\:x)`: the class is the subject of the argument.
  const inner = /^:(?:is|where)\((.*)\)$/.exec(subject);
  return inner ? splitTopLevel(inner[1]!, (char) => char === ",").some((part) => stylesItsElement(part.trim(), className)) : false;
};

/** CSS escaping of a class name, as Tailwind writes it into the selector. */
const escapeClass = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);

const sides = ["top", "right", "bottom", "left"] as const;
const box = (prefix: string, suffix = "") => sides.map((side) => `${prefix}-${side}${suffix}`);
/** The longhands a shorthand sets; logical sides map to the physical ones of a left-to-right page. */
const longhands = (property: string): string[] => {
  const boxed = /^(padding|margin|scroll-padding|scroll-margin)(?:-(inline|block|inline-start|inline-end|block-start|block-end))?$/.exec(
    property,
  );
  if (boxed) {
    const [, base, axis] = boxed;
    const all = box(base!);
    if (!axis) return all;
    return {
      inline: [all[1]!, all[3]!],
      block: [all[0]!, all[2]!],
      "inline-start": [all[3]!],
      "inline-end": [all[1]!],
      "block-start": [all[0]!],
      "block-end": [all[2]!],
    }[axis]!;
  }
  const border =
    /^border(?:-(inline|block|top|right|bottom|left|inline-start|inline-end|block-start|block-end))?-(width|color|style)$/.exec(property);
  if (border) {
    const [, axis, kind] = border;
    const all = box("border", `-${kind}`);
    if (!axis) return all;
    const pick = {
      inline: [1, 3],
      block: [0, 2],
      top: [0],
      right: [1],
      bottom: [2],
      left: [3],
      "inline-start": [3],
      "inline-end": [1],
      "block-start": [0],
      "block-end": [2],
    }[axis]!;
    return pick.map((side) => all[side]!);
  }
  if (property === "border-radius")
    return ["top-left", "top-right", "bottom-right", "bottom-left"].map((corner) => `border-${corner}-radius`);
  const logicalCorner: Record<string, string> = {
    "border-start-start-radius": "border-top-left-radius",
    "border-start-end-radius": "border-top-right-radius",
    "border-end-end-radius": "border-bottom-right-radius",
    "border-end-start-radius": "border-bottom-left-radius",
  };
  if (logicalCorner[property]) return [logicalCorner[property]];
  const pairs: Record<string, string[]> = {
    inset: ["top", "right", "bottom", "left"],
    "inset-inline": ["right", "left"],
    "inset-block": ["top", "bottom"],
    "inset-inline-start": ["left"],
    "inset-inline-end": ["right"],
    gap: ["row-gap", "column-gap"],
    overflow: ["overflow-x", "overflow-y"],
    overscroll: ["overscroll-behavior-x", "overscroll-behavior-y"],
    "overscroll-behavior": ["overscroll-behavior-x", "overscroll-behavior-y"],
    flex: ["flex-grow", "flex-shrink", "flex-basis"],
    "place-items": ["align-items", "justify-items"],
    "place-content": ["align-content", "justify-content"],
    "place-self": ["align-self", "justify-self"],
    "grid-column": ["grid-column-start", "grid-column-end"],
    "grid-row": ["grid-row-start", "grid-row-end"],
    "grid-area": ["grid-row-start", "grid-column-start", "grid-row-end", "grid-column-end"],
  };
  return pairs[property] ?? [property];
};

/** The longhands one rule sets, with their values. */
const declaredLonghands = (rule: StyleRule): Map<string, string> => {
  const result = new Map<string, string>();
  for (const [property, value] of rule.declarations) for (const longhand of longhands(property)) result.set(longhand, value);
  return result;
};

/** Variants of a class (`sm`, `dark`, …); a plain utility has none. Brackets keep their colons (`[mask:none]`). */
const variantsOf = (candidate: string): string[] => splitTopLevel(candidate, (char) => char === ":").slice(0, -1);

/** A scoped form of `plain` that leaves the same look in either stylesheet order, where one is obvious. */
const complement = (variant: string): string | undefined => {
  const parts = variantsOf(variant);
  if (parts.length !== 1) return undefined;
  const [part] = parts as [string];
  if (/^(sm|md|lg|xl|2xl)$/.test(part)) return `max-${part}`;
  if (/^max-(sm|md|lg|xl|2xl)$/.test(part)) return part.slice(4);
  if (/^@(?!max-)[\w-]+$/.test(part)) return `@max-${part.slice(1)}`;
  if (/^min-\[.+\]$/.test(part)) return `max-${part.slice(4)}`;
  return { dark: "not-dark", "motion-safe": "motion-reduce", "motion-reduce": "motion-safe", print: "not-print" }[part];
};

/** The class lists in one string: the values of its `class="…"` attributes when it holds HTML, else the string itself. */
const classLists = (text: string): string[] => {
  const attributes = [...text.matchAll(/\bclass(?:Name)?=(["'])/g)];
  if (attributes.length === 0) return [text];
  return attributes.map((attribute) => {
    const start = attribute.index + attribute[0].length;
    const end = text.indexOf(attribute[1]!, start);
    return text.slice(start, end < 0 ? undefined : end);
  });
};

export type Collision = { plain: string; variant: string; line: number; file: string };

/** The plain/variant pairs in one source file whose variant an app's repeated plain utility would cancel. */
export const collisionsIn = async (file: string, source: string): Promise<Collision[]> => {
  const system = await loadDesignSystem();
  const utilities = new Map<string, Utility | null>();
  const utility = (candidate: string): Utility | null => {
    if (!utilities.has(candidate)) {
      const css = system.candidatesToCss([candidate])[0];
      utilities.set(candidate, css ? { rules: styleRules(css) } : null);
    }
    return utilities.get(candidate)!;
  };
  const { sourceFile } = parseSource(file, source);
  const collisions: Collision[] = [];
  // Strings a template already read as part of its class list.
  const inTemplate = new Set<ts.Node>();

  /**
   * The class texts an expression can add, one per alternative: a string, each branch of a condition, the strings
   * beside `&&`, `||` and `??`, and each text of a nested template. Anything else adds no known class.
   */
  const alternatives = (node: ts.Expression): string[] => {
    if (ts.isStringLiteralLike(node)) {
      inTemplate.add(node);
      return [node.text];
    }
    if (ts.isTemplateExpression(node)) {
      inTemplate.add(node);
      return templateTexts(node);
    }
    if (ts.isParenthesizedExpression(node)) return alternatives(node.expression);
    if (ts.isConditionalExpression(node)) return [...alternatives(node.whenTrue), ...alternatives(node.whenFalse)];
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
        node.operatorToken.kind,
      )
    )
      return [...alternatives(node.left), ...alternatives(node.right)];
    return [];
  };

  /**
   * Every class text a template can produce: its static parts with one alternative of each substitution. In
   * `flex ${open ? "md:hidden" : ""}` the shared `md:hidden` sits on the same element as `flex`; the branches of
   * one condition never meet. A substitution without a known class adds nothing.
   */
  const templateTexts = (node: ts.TemplateExpression): string[] =>
    node.templateSpans.reduce(
      (texts, span) => {
        const options = alternatives(span.expression);
        return (options.length ? options : [""]).flatMap((option) => texts.map((text) => `${text} ${option} ${span.literal.text}`));
      },
      [node.head.text],
    );

  const visit = (node: ts.Node): void => {
    const texts = inTemplate.has(node)
      ? []
      : ts.isStringLiteralLike(node)
        ? [node.text]
        : ts.isTemplateExpression(node)
          ? templateTexts(node)
          : [];
    // One template's texts repeat their static pairs; report each pair once per node.
    const reported = new Set<string>();
    for (const list of texts.flatMap(classLists)) {
      // `!` makes a class important; then the stylesheet order decides nothing.
      const tokens = [...new Set(list.split(/\s+/).filter((token) => token && !token.startsWith("!") && !token.endsWith("!")))];
      const plains = tokens.filter((token) => variantsOf(token).length === 0);
      const variants = tokens.filter((token) => variantsOf(token).length > 0);
      if (plains.length > 0 && variants.length > 0) {
        for (const plain of plains) {
          const plainUtility = utility(plain);
          const plainRule = plainUtility?.rules.length === 1 ? plainUtility.rules[0] : undefined;
          if (!plainRule) continue;
          const plainSpecificity = specificity(plainRule.selector);
          const plainLonghands = declaredLonghands(plainRule);
          for (const variant of variants) {
            const variantUtility = utility(variant);
            if (!variantUtility) continue;
            const collides = variantUtility.rules.some((rule) => {
              if (compare(specificity(rule.selector), plainSpecificity) !== 0) return false;
              if (!stylesItsElement(rule.selector, escapeClass(variant))) return false;
              for (const [longhand, value] of declaredLonghands(rule)) {
                if (plainLonghands.has(longhand) && plainLonghands.get(longhand) !== value) return true;
              }
              return false;
            });
            if (collides && !reported.has(`${plain} ${variant}`)) {
              reported.add(`${plain} ${variant}`);
              collisions.push({ file, plain, variant, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return collisions;
};

export const rule: Rule = {
  name: "scoped-variants",
  description: "shared UI scopes both sides when a plain utility and a variant set the same property",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    for (const file of roots.flatMap((root) => listFiles(join(workspaceRoot, root), sourceFilePattern)).sort()) {
      // Tests and their browser harnesses, fixtures and frames never render inside an app page.
      if (isTestFile(file) || /\.browser-[a-z]+\.tsx?$/.test(file)) continue;
      for (const { plain, variant, line } of await collisionsIn(file, readFileSync(file, "utf8"))) {
        const scoped = complement(variant);
        findings.push({
          file,
          line,
          message: `"${plain}" with "${variant}": an app stylesheet loaded later that repeats "${plain}" cancels "${variant}"; scope both sides${
            scoped ? `, as in "${scoped}:${plain} ${variant}"` : ""
          }.`,
        });
      }
    }
    return findings;
  },
};
