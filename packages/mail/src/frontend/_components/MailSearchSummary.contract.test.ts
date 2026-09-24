import { describe, expect, test } from "bun:test";
import { cssDeclarations, parseCssRules } from "../../../../ui/src/styles/css-contract-test-helpers";

const rules = parseCssRules("app.css", await Bun.file(new URL("../../styles/app.css", import.meta.url)).text());
const declarations = (selector: string) => {
  const rule = rules.find((candidate) => candidate.selector === selector && !candidate.context);
  if (!rule) throw new Error(`missing rule ${selector}`);
  return cssDeclarations(rule.body);
};

describe("Mail search summary", () => {
  test("is a muted secondary-size row with a stable 32px target", () => {
    const summary = declarations(".k2b-ui .mail-search-summary");
    expect(summary.get("color")).toEqual(["var(--k2b-text-muted)"]);
    expect(summary.get("font-size")).toEqual(["0.75rem"]);
    expect(summary.get("min-height")).toEqual(["2rem"]);
    expect(summary.get("cursor")).toEqual(["pointer"]);
    expect(summary.has("transition")).toBe(false);
  });

  test("only underlines the text on hover and keeps the shared focus ring", () => {
    const hover = rules.filter((rule) => rule.selector.includes(".mail-search-summary:hover"));
    expect(hover.map((rule) => rule.selector)).toEqual([".k2b-ui .mail-search-summary:hover .mail-search-summary__text"]);
    expect([...cssDeclarations(hover[0]!.body)]).toEqual([["text-decoration-line", ["underline"]]]);
    expect(declarations(".k2b-ui .mail-search-summary:focus-visible").get("outline")).toEqual(["2px solid var(--k2b-focus-ring)"]);
  });
});
