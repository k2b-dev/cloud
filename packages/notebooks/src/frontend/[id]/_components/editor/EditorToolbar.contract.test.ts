import { describe, expect, test } from "bun:test";
import { cssDeclarations, parseCssRules } from "../../../../../../ui/src/styles/css-contract-test-helpers";

const rules = parseCssRules("app.css", await Bun.file(new URL("../../../../styles/app.css", import.meta.url)).text());
const FOCUS = ".k2b-ui .notebooks-editor-toolbar .k2b-button.k2b-icon-button:not(:disabled):focus-visible";
const declarations = (context: string) => {
  const rule = rules.find((candidate) => candidate.selector === FOCUS && candidate.context === context);
  if (!rule) throw new Error(`missing ${FOCUS} in "${context}"`);
  return cssDeclarations(rule.body);
};

describe("Notebooks editor toolbar focus", () => {
  test("shows focus as a blue icon on a faint tint without a ring or motion", () => {
    const focus = declarations("");
    expect(focus.get("outline")).toEqual(["none"]);
    expect(focus.get("box-shadow")).toEqual(["none"]);
    expect(focus.get("color")).toEqual(["var(--k2b-focus-ring)"]);
    expect(focus.get("background")).toEqual(["color-mix(in srgb, var(--k2b-focus-ring) 12%, transparent)"]);
    for (const motion of ["transform", "translate", "scale", "transition", "animation"]) expect(focus.has(motion)).toBe(false);
  });

  test("falls back to an inset system outline in forced-colors mode", () => {
    const forced = declarations("@media (forced-colors: active)");
    expect(forced.get("outline")).toEqual(["2px solid Highlight"]);
    expect(forced.get("outline-offset")).toEqual(["-2px"]);
  });
});
