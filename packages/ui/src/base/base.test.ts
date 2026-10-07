import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type CssRule, cssDeclarations, parseCssRules, splitTopLevel } from "../styles/css-contract-test-helpers";

const read = (path: string) => readFileSync(resolve(import.meta.dir, path), "utf8");
const base = parseCssRules("base.css", read("base.css"));
const components = [...parseCssRules("index.css", read("../styles/index.css")), ...parseCssRules("plex.css", read("../fonts/plex.css"))];

const normalize = (value: string) => value.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim().toLowerCase();

/** Custom properties of every top-level rule with this selector, later rules winning. */
const tokens = (rules: CssRule[], selector: string, context: string): Map<string, string> => {
  const result = new Map<string, string>();
  for (const rule of rules.filter((rule) => rule.selector === selector && rule.context === context)) {
    for (const [name, values] of cssDeclarations(rule.body)) if (name.startsWith("--")) result.set(name, values.at(-1)!);
  }
  return result;
};

/** Replaces `var(--name)` with the value it has in the given scopes, the first scope winning. */
const resolveValue = (value: string, scopes: Map<string, string>[]): string =>
  value.replace(/var\((--[\w-]+)\)/g, (reference, name: string) => {
    const next = scopes.find((scope) => scope.has(name))?.get(name);
    return next === undefined ? reference : resolveValue(next, scopes);
  });

describe("@k2b/ui base stylesheet", () => {
  test("carries the tokens of the .k2b-ui scope with the same values in light and dark", () => {
    const light = tokens(components, ".k2b-ui", "");
    const dark = tokens(components, '.k2b-ui[data-theme="dark"]', "");
    const baseRoot = tokens(base, ":root", "@layer k2b-base");
    const baseDark = tokens(base, ':root[data-theme="dark"]', "@layer k2b-base");
    expect(baseRoot.size).toBeGreaterThan(40);

    for (const [name, value] of baseRoot) {
      const pair = value.match(/^light-dark\((.*)\)$/s)?.[1];
      const [baseLight, baseDarkValue] = pair ? splitTopLevel(pair, ",") : [value, value];
      const expected = {
        light: light.has(name) ? resolveValue(light.get(name)!, [light]) : undefined,
        dark: light.has(name) ? resolveValue(dark.get(name) ?? light.get(name)!, [dark, light]) : undefined,
      };
      expect({ name, light: normalize(baseLight!) }).toEqual({ name, light: normalize(expected.light ?? "missing in .k2b-ui") });
      expect({ name, dark: normalize(baseDark.get(name) ?? baseDarkValue!) }).toEqual({ name, dark: normalize(expected.dark ?? "") });
    }
  });

  test("defines every custom property it reads, apart from the chart size that chart markup sets", () => {
    const defined = new Set(base.flatMap((rule) => [...cssDeclarations(rule.body).keys()].filter((name) => name.startsWith("--"))));
    const used = new Set([...read("base.css").matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]!));
    const missing = [...used].filter((name) => !defined.has(name) && name !== "--k2b-chart-width" && name !== "--k2b-chart-height");
    expect(missing).toEqual([]);
  });

  test("puts every rule in the k2b-base layer", () => {
    expect(base.filter((rule) => !rule.context.startsWith("@layer k2b-base")).map((rule) => rule.selector)).toEqual([]);
  });

  // An element rule that sets a block margin outranks the zero-specificity
  // flow rules and silently cancels the rhythm (a filter bar glued to the form
  // above it). Only flow rules, written entirely in :where(), set block
  // margins. The exceptions below never sit in a flow as styled elements.
  test("sets block margins only through the flow rules", () => {
    const exceptions = new Set([
      "body", // the page root, never a sibling
      'input:is([type="checkbox"], [type="radio"])', // the control box inside its label or row
      'button[aria-busy="true"]::after', // the centered spinner
      ".row > *", // helpers take the flow margin from their children
      ".grid > *",
      ".stat > *",
    ]);
    const blockMargin = /^margin(?:-top|-bottom|-block(?:-start|-end)?)?$/;
    const withoutWhere = (selector: string) => {
      let rest = selector;
      for (let index = rest.indexOf(":where("); index >= 0; index = rest.indexOf(":where(")) {
        let depth = 0;
        let end = index + ":where".length;
        for (; end < rest.length; end += 1) {
          if (rest[end] === "(") depth += 1;
          else if (rest[end] === ")" && --depth === 0) break;
        }
        rest = rest.slice(0, index) + rest.slice(end + 1);
      }
      return rest;
    };
    const offenders = base
      .filter((rule) => [...cssDeclarations(rule.body).keys()].some((name) => blockMargin.test(name)))
      .filter((rule) => !exceptions.has(rule.selector) && !/^[\s>+~*]*$/.test(withoutWhere(rule.selector)))
      .map((rule) => rule.selector);
    expect(offenders).toEqual([]);
  });
});
