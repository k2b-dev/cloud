import { expect, test } from "bun:test";
import { cssDeclarations, parseCssRules, readShippedCssRules } from "../styles/css-contract-test-helpers";

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

test("floating Toolbar is a pill with the toolbar shadow, reserves height, and keeps hints out of layout", () => {
  const declarations = (selector: string) => {
    const rule = rules.find((rule) => rule.selector === selector && rule.context === "");
    expect(rule, selector).toBeDefined();
    return cssDeclarations(rule!.body);
  };
  const pill = declarations('.k2b-ui .k2b-toolbar[data-variant="floating"]');
  expect(pill.get("box-shadow")).toEqual(["var(--k2b-shadow-toolbar)"]);
  expect(pill.get("border-radius")).toEqual(["999px"]);
  // 44 px controls by default; a host may lower `--k2b-toolbar-control`, and the pill follows its controls.
  expect(pill.get("block-size")).toEqual(["calc(var(--k2b-toolbar-control, 2.75rem) + 0.5rem + 2px)"]);
  const controls = rules.find((rule) => rule.selector.startsWith('.k2b-ui .k2b-toolbar[data-variant="floating"] .k2b-button:not('));
  expect(controls && cssDeclarations(controls.body).get("block-size")).toEqual(["var(--k2b-toolbar-control, 2.75rem)"]);
  const strip = declarations(".k2b-ui .k2b-toolbar-float");
  expect(strip.get("position")).toEqual(["sticky"]);
  expect(strip.get("margin-block-start")).toEqual(["auto"]);
  // `edge="top"` sticks the strip to the top of its column in its place in the flow.
  const top = declarations('.k2b-ui .k2b-toolbar-float[data-edge="top"]');
  expect(top.get("inset-block")).toEqual(["0 auto"]);
  expect(top.get("margin-block-start")).toEqual(["0"]);
  // Compact: labels go before any action moves into More.
  expect(declarations(".k2b-ui .k2b-toolbar[data-compact] .k2b-toolbar__text").get("display")).toEqual(["none"]);
  expect(strip.get("pointer-events")).toEqual(["none"]);
  expect(declarations(".k2b-ui .k2b-toolbar .k2b-toolbar__hint").get("position")).toEqual(["absolute"]);
  // Measuring never shows or hides More, which would drop focus from it: an idle More keeps its box out of the flow.
  const idleMore = declarations('.k2b-ui .k2b-toolbar > .k2b-toolbar__more[data-overflow="hidden"]');
  expect(idleMore.get("display")).toEqual(["block !important"]);
  expect(idleMore.get("position")).toEqual(["absolute"]);
  expect(idleMore.get("visibility")).toEqual(["hidden"]);
  expect(declarations(".k2b-ui .k2b-toolbar[data-overflow-pending]").get("visibility")).toEqual(["hidden"]);
  expect(declarations(".k2b-ui .k2b-toolbar[data-overflow-pending]").get("opacity")).toEqual(["0"]);
  expect(
    rules.some(
      (rule) =>
        rule.selector === ".k2b-ui .k2b-toolbar[data-overflow-pending]" &&
        rule.context === "@media (scripting: none)" &&
        cssDeclarations(rule.body).get("visibility")?.includes("visible"),
    ),
  ).toBe(true);
});

test("toolbar hover and keyboard hints never change layout or move controls", () => {
  const shipped = readShippedCssRules(new URL("../styles", import.meta.url).pathname);
  const keyboardRules = shipped.filter((rule) => rule.selector.includes("data-k2b-kbd"));
  expect(keyboardRules).toHaveLength(1);
  expect(keyboardRules[0]!.selector).toBe(':where(html[data-k2b-kbd="on"]) .k2b-ui .k2b-kbd-hint');
  expect([...cssDeclarations(keyboardRules[0]!.body)]).toEqual([["visibility", ["visible"]]]);
  const hoverRules = shipped.filter((rule) => rule.selector.includes("k2b-toolbar") && rule.selector.includes(":hover"));
  expect(hoverRules.length).toBeGreaterThan(0);
  for (const rule of hoverRules) {
    for (const property of cssDeclarations(rule.body).keys()) {
      expect(["color", "background", "background-color", "border-color", "box-shadow", "opacity"], rule.selector).toContain(property);
    }
  }
});
