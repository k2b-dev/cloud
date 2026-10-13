import { expect, test } from "bun:test";
import { cssDeclarations, parseCssRules } from "../styles/css-contract-test-helpers";

const css = await Bun.file(new URL("../styles/index.css", import.meta.url)).text();
const rules = parseCssRules("index.css", css);
const selector = '.k2b-ui .k2b-toolbar .k2b-button[aria-pressed="true"]';

test("pressed toolbar buttons change only colour and background, including hover", () => {
  for (const target of [selector, `${selector}:hover:not(:disabled)`]) {
    const rule = rules.find((rule) => rule.selector === target && rule.context === "");
    expect(rule).toBeDefined();
    const declarations = cssDeclarations(rule!.body);
    expect([...declarations.keys()].sort()).toEqual(["background", "color"]);
    expect(declarations.get("color")).toEqual(["var(--k2b-action)"]);
    expect(declarations.get("background")).toEqual(["var(--k2b-selected)"]);
  }
  expect(css).toContain("--k2b-action:");
  expect(css).toContain("--k2b-selected:");
});

test("pressed toolbar buttons retain their state in forced colours", () => {
  const rule = rules.find((rule) => rule.selector === selector && rule.context === "@media (forced-colors: active)");
  expect(rule).toBeDefined();
  expect([...cssDeclarations(rule!.body)]).toEqual([
    ["forced-color-adjust", ["none"]],
    ["color", ["HighlightText"]],
    ["background", ["Highlight"]],
  ]);
});
