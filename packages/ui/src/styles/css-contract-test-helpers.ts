import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type CssRule = {
  context: string;
  file: string;
  selector: string;
  body: string;
};

export const splitTopLevel = (value: string, delimiter: string): string[] => {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth -= 1;
    else if (character === delimiter && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
};

const closingBrace = (css: string, opening: number): number => {
  let depth = 1;
  let quote = "";
  for (let index = opening + 1; index < css.length; index += 1) {
    const character = css[index]!;
    if (quote) {
      if (character === quote && css[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  throw new Error(`Unclosed CSS block at offset ${opening}`);
};

const normalize = (value: string) => value.split(/\s+/).filter(Boolean).join(" ");

export const parseCssRules = (file: string, source: string): CssRule[] => {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];

  const visit = (start: number, end: number, contexts: string[]) => {
    let cursor = start;
    while (cursor < end) {
      while (/\s/.test(css[cursor] ?? "")) cursor += 1;
      const opening = css.indexOf("{", cursor);
      const semicolon = css.indexOf(";", cursor);
      if (opening < 0 || opening >= end || (semicolon >= 0 && semicolon < opening)) {
        cursor = semicolon >= 0 && semicolon < end ? semicolon + 1 : end;
        continue;
      }

      const header = normalize(css.slice(cursor, opening));
      const closing = closingBrace(css, opening);
      if (header.startsWith("@") && !header.startsWith("@font-face") && !header.startsWith("@property")) {
        if (!/^@(?:keyframes|-webkit-keyframes)\b/.test(header)) visit(opening + 1, closing, [...contexts, header]);
      } else if (header && !header.startsWith("@")) {
        for (const selector of splitTopLevel(header, ",").map(normalize).filter(Boolean)) {
          rules.push({
            context: contexts.join(" > "),
            file,
            selector,
            body: css.slice(opening + 1, closing).trim(),
          });
        }
      }
      cursor = closing + 1;
    }
  };

  visit(0, css.length, []);
  return rules;
};

export const shippedStyleFiles = (stylesDir: string): string[] => {
  const entry = readFileSync(resolve(stylesDir, "entry.css"), "utf8");
  return [...entry.matchAll(/@import\s+["']\.\/([^"']+\.css)["']/g)].map((match) => match[1]!);
};

export const readShippedCssRules = (stylesDir: string): CssRule[] =>
  shippedStyleFiles(stylesDir).flatMap((file) => parseCssRules(file, readFileSync(resolve(stylesDir, file), "utf8")));

export const cssDeclarations = (body: string): Map<string, string[]> => {
  const declarations = new Map<string, string[]>();
  for (const raw of splitTopLevel(body.replace(/\/\*[\s\S]*?\*\//g, ""), ";")) {
    const separator = raw.indexOf(":");
    if (separator < 0) continue;
    const property = raw.slice(0, separator).trim().toLowerCase();
    const value = raw.slice(separator + 1).trim();
    if (!property || !value) continue;
    declarations.set(property, [...(declarations.get(property) ?? []), value]);
  }
  return declarations;
};

const visibleValue = (values: string[] | undefined) =>
  values?.some((value) => !/^(?:none|0(?:px)?|transparent|initial|inherit|unset)(?:\s*!important)?$/i.test(value)) ?? false;

const focusShadow = (values: string[] | undefined) =>
  values?.some(
    (value) =>
      !/\binset\b/i.test(value) &&
      (/(?:focus|action|ai-border|ui-focus)/i.test(value) || /\b0(?:px)?\s+0(?:px)?\s+0(?:px)?\s+(?!0(?:px)?(?:\s|$))/.test(value)),
  ) ?? false;

export const focusSignalCount = (body: string): number => {
  const declarations = cssDeclarations(body);
  const border =
    visibleValue(declarations.get("border-color")) ||
    [...declarations].some(
      ([property, values]) => /^border(?:-(?:block|inline)(?:-(?:start|end))?)?$/.test(property) && visibleValue(values),
    );
  const outline = visibleValue(declarations.get("outline")) || visibleValue(declarations.get("outline-color"));
  const shadow = focusShadow(declarations.get("box-shadow"));
  return Number(border) + Number(outline) + Number(shadow);
};

export const isFocusSelector = (selector: string): boolean =>
  /:focus(?:-visible|-within)?|\[data-(?:focus|focused)(?:[=\]])|\.is-focused(?![\w-])/.test(selector);
