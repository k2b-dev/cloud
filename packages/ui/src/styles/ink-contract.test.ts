import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type CssRule, cssDeclarations, parseCssRules } from "./css-contract-test-helpers";

const read = (path: string) => readFileSync(resolve(import.meta.dir, path), "utf8");
const rules = parseCssRules("index.css", read("index.css"));
const base = parseCssRules("base.css", read("../base/base.css"));

const tokens = (rules: CssRule[], selector: string, context = ""): Map<string, string> => {
  const result = new Map<string, string>();
  for (const rule of rules.filter((rule) => rule.selector === selector && rule.context === context)) {
    for (const [name, values] of cssDeclarations(rule.body)) if (name.startsWith("--")) result.set(name, values.at(-1)!);
  }
  return result;
};

const resolveValue = (value: string, scopes: Map<string, string>[]): string =>
  value.replace(/var\((--[\w-]+)\)/g, (reference, name: string) => {
    const next = scopes.find((scope) => scope.has(name))?.get(name);
    return next === undefined ? reference : resolveValue(next, scopes);
  });

const light = tokens(rules, ".k2b-ui");
const dark = tokens(rules, '.k2b-ui[data-theme="dark"]');
const color = (name: string, scopes: Map<string, string>[]) => resolveValue(`var(${name})`, scopes);

// WCAG 2 relative luminance: linearize sRGB channels before weighting them.
const luminance = (hex: string): number => {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error(`Expected #rrggbb, got ${hex}`);
  const channel = (offset: number) => {
    const srgb = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

const contrast = (foreground: string, background: string): number => {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

describe("@k2b/ui ink contract", () => {
  test("sets dark ink for exactly the three supported theme selectors", () => {
    const darkInk = rules.filter((rule) => rule.selector !== ".k2b-ui" && cssDeclarations(rule.body).has("--k2b-text-secondary"));
    expect(darkInk.map((rule) => rule.selector)).toEqual(['.k2b-ui[data-theme="dark"]', ".k2b-ui.k2b-dark", ".dark .k2b-ui"]);
    expect(darkInk.map((rule) => rule.context)).toEqual(["", "", ""]);
    expect(new Set(darkInk.map((rule) => rule.body)).size).toBe(1);
  });

  test("pins secondary and muted ink in both themes and the base light-dark pairs", () => {
    const baseRoot = tokens(base, ":root", "@layer k2b-base");
    for (const { name, lightValue, darkValue } of [
      { name: "--k2b-text-secondary", lightValue: "#27272a", darkValue: "#f1f1f3" },
      { name: "--k2b-text-muted", lightValue: "#45454e", darkValue: "#bdbdc6" },
    ]) {
      expect({ name, light: color(name, [light]), dark: color(name, [dark, light]) }).toEqual({
        name,
        light: lightValue,
        dark: darkValue,
      });
      expect({ name, pair: baseRoot.get(name) }).toEqual({ name, pair: `light-dark(${lightValue}, ${darkValue})` });
    }
  });

  test("keeps secondary at 10:1 and muted at 7:1 on both surfaces in both themes", () => {
    for (const { theme, scopes } of [
      { theme: "light", scopes: [light] },
      { theme: "dark", scopes: [dark, light] },
    ]) {
      for (const { name, minimum } of [
        { name: "--k2b-text-secondary", minimum: 10 },
        { name: "--k2b-text-muted", minimum: 7 },
      ]) {
        for (const surface of ["--k2b-surface", "--k2b-surface-muted"]) {
          const foreground = color(name, scopes);
          const background = color(surface, scopes);
          expect(contrast(foreground, background), JSON.stringify({ name, theme, surface, foreground, background })).toBeGreaterThanOrEqual(
            minimum,
          );
        }
      }
    }
  });
});
