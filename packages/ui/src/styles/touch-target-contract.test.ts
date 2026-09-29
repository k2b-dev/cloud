import { describe, expect, test } from "bun:test";
import { cssDeclarations, readShippedCssRules } from "./css-contract-test-helpers";

const rules = readShippedCssRules(import.meta.dir);
const coarse = "@media (any-pointer: coarse)";
const hitArea = "min(0px, calc((100% - 2.75rem) / 2))";
const declarations = (selector: string, context = coarse) =>
  cssDeclarations(
    rules
      .filter((rule) => rule.selector === selector && rule.context === context)
      .map((rule) => rule.body)
      .join(";"),
  );

describe("@k2b/ui touch targets", () => {
  test("gives buttons, the dialog close control, and the toast action and close button a 2.75rem hit area on coarse pointers", () => {
    expect(declarations(":where(.k2b-ui .k2b-button)").get("position")).toEqual(["relative"]);
    expect(declarations(".k2b-ui .k2b-dialog__close").get("position")).toEqual(["relative"]);
    expect(declarations(".k2b-ui .k2b-toast__action").get("position")).toEqual(["relative"]);
    expect(declarations(".k2b-ui .k2b-toast__close").get("position")).toEqual(["relative"]);

    const button = declarations(".k2b-ui .k2b-button::after");
    expect(button.get("content")).toEqual(['""']);
    expect(button.get("position")).toEqual(["absolute"]);
    expect(button.get("inset-block")).toEqual([hitArea]);
    expect(button.get("inset-inline")).toEqual([hitArea]);

    const close = declarations(".k2b-ui .k2b-dialog__close::after");
    expect(close.get("position")).toEqual(["absolute"]);
    expect(close.get("inset")).toEqual([hitArea]);

    for (const selector of [".k2b-ui .k2b-toast__action::after", ".k2b-ui .k2b-toast__close::after"]) {
      const toast = declarations(selector);
      expect(toast.get("content")).toEqual(['""']);
      expect(toast.get("position")).toEqual(["absolute"]);
      expect(toast.get("inset")).toEqual([hitArea]);
    }
  });

  test("keeps the visible size and every pointer-fine layout unchanged, except for flush DetailPanel.Action rows", () => {
    const controls = /\.k2b-(?:button|dialog__close|toast__(?:action|close))\b/;
    const pseudo = rules.filter((rule) => controls.test(rule.selector) && /::?(?:before|after)\b/.test(rule.selector));
    expect(pseudo.length).toBeGreaterThan(0);
    expect(pseudo.filter((rule) => rule.context !== coarse).map((rule) => `${rule.file}: ${rule.selector}`)).toEqual([]);

    const resized = rules
      .filter((rule) => rule.context === coarse && controls.test(rule.selector))
      .filter((rule) =>
        [...cssDeclarations(rule.body).keys()].some((property) => /^(?:width|height|min-|max-|padding|margin|font-size)/.test(property)),
      )
      .map((rule) => rule.selector);
    // Stacked action rows have no room for a tap area beyond their box, so the row itself grows to 2.75rem.
    expect(resized).toEqual([".k2b-ui .k2b-button.k2b-detail-panel__action", ".k2b-ui .k2b-detail-panel__action-row .k2b-button"]);
    const row = declarations(".k2b-ui .k2b-button.k2b-detail-panel__action");
    expect([...row.entries()]).toEqual([["min-height", ["2.75rem"]]]);
    expect([...declarations(".k2b-ui .k2b-detail-panel__action-row .k2b-button").entries()]).toEqual([["min-height", ["2.75rem"]]]);
  });
});
