import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss, { type Rule } from "postcss";
import selectorParser from "postcss-selector-parser";
import { heights, radii, textEdge, typeRoles } from "./tokens";

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const root = postcss.parse(css);

/** The declarations of the rule whose selector is exactly `selector`, outside any at-rule unless `media` names one. */
const declarations = (selector: string, media?: string): Map<string, string> => {
  const found = new Map<string, string>();
  root.walkRules((rule) => {
    const parent = rule.parent?.type === "atrule" ? (rule.parent as postcss.AtRule).params : undefined;
    if (rule.selector !== selector || parent !== media) return;
    rule.walkDecls((declaration) => {
      found.set(declaration.prop, declaration.value);
    });
  });
  return found;
};

const scope = declarations(".k2-ui");
const phone = declarations(".k2-ui", "(max-width: 767px)");

test("the type roles in v2.css are the roles in tokens.ts", () => {
  for (const [role, { size, lineHeight, weight }] of Object.entries(typeRoles))
    expect(scope.get(`--k2-t-${role}`)).toBe(`${weight} ${size}px/${lineHeight}px var(--k2-font)`);
});

test("the text edge is 20 px, 16 px below 768 px, and 24 px further in after an icon", () => {
  expect(scope.get("--k2-edge")).toBe(`${textEdge.wide}px`);
  expect(phone.get("--k2-edge")).toBe(`${textEdge.phone}px`);
  expect(scope.get("--k2-edge-icon")).toBe(`calc(var(--k2-edge) + ${textEdge.afterIcon}px)`);
  expect(phone.size).toBe(1);
});

test("there is one hairline of 1 px, and the radii and heights are the tokens", () => {
  expect(scope.get("--k2-hairline")).toBe("1px solid var(--k2-line)");
  expect(scope.get("--k2-r-mark")).toBe(`${radii.mark}px`);
  expect(scope.get("--k2-r-control")).toBe(`${radii.control}px`);
  expect(scope.get("--k2-r-overlay")).toBe(`${radii.overlay}px`);
  expect(scope.get("--k2-r-round")).toBe(`${radii.round}px`);
  expect(scope.get("--k2-r-card")).toBe(`${radii.card}px`);
  const names: Record<keyof typeof heights, string> = {
    head: "head",
    status: "status",
    tabs: "tabs",
    bar: "bar",
    columns: "columns",
    row: "row",
    row2: "row2",
    row3: "row3",
    dense: "dense",
    control: "control",
    controlSmall: "control-small",
  };
  for (const [key, name] of Object.entries(names)) expect(scope.get(`--k2-h-${name}`)).toBe(`${heights[key as keyof typeof heights]}px`);
});

test("dark mode redefines only colours and shadows, never a measure", () => {
  const dark = declarations('.dark .k2-ui:not([data-theme="light"]),\n.k2-ui.dark,\n.k2-ui[data-theme="dark"]');
  expect(dark.size).toBeGreaterThan(20);
  for (const [property, value] of dark) {
    expect(property.startsWith("--k2-")).toBe(true);
    expect(/^(?:#[0-9a-f]{6}|rgb\(|0 )/.test(value)).toBe(true);
  }
  // Every colour the dark theme sets exists in light first.
  for (const property of dark.keys()) expect(scope.has(property)).toBe(true);
});

test("v2.css stays in its namespace below .k2-ui, beside v1", () => {
  const problems: string[] = [];
  root.walkDecls((declaration) => {
    if (declaration.prop.startsWith("--") && !declaration.prop.startsWith("--k2-")) problems.push(`custom property ${declaration.prop}`);
    for (const match of declaration.value.matchAll(/var\(\s*(--[\w-]+)/g))
      if (!match[1]!.startsWith("--k2-")) problems.push(`${declaration.prop} reads ${match[1]}`);
  });
  root.walkRules((rule: Rule) => {
    selectorParser((selectors) => {
      selectors.each((selector) => {
        let scoped = false;
        selector.walk((node) => {
          if (node.type === "class") {
            if (node.value === "k2-ui") scoped = true;
            else if (node.value !== "dark" && !node.value.startsWith("k2-")) problems.push(`class .${node.value} in ${rule.selector}`);
          }
          if (node.type === "tag" || node.type === "universal" || (node.type === "pseudo" && node.value === ":root"))
            problems.push(`${node.toString().trim()} in ${rule.selector}`);
        });
        if (!scoped) problems.push(`${selector.toString().trim()} is not below .k2-ui`);
      });
    }).processSync(rule.selector);
  });
  expect(problems).toEqual([]);
});

test("every custom property v2.css reads is one it defines", () => {
  const defined = new Set<string>();
  root.walkDecls((declaration) => {
    if (declaration.prop.startsWith("--")) defined.add(declaration.prop);
  });
  const missing: string[] = [];
  root.walkDecls((declaration) => {
    for (const match of declaration.value.matchAll(/var\(\s*(--[\w-]+)/g)) if (!defined.has(match[1]!)) missing.push(match[1]!);
  });
  expect(missing).toEqual([]);
});
