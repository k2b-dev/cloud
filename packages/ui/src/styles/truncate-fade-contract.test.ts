import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cssDeclarations, parseCssRules, readShippedCssRules } from "./css-contract-test-helpers";

const message = "navigation labels fade with `k2b-truncate-fade`, they never end in an ellipsis";
const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const builtRules = parseCssRules("dist/styles.css", css);
const navigation =
  /\.k2b-(?:app-workspace__(?:sidebar|nav-tree|level-title)|settings__tab|tab-bar|sidebar-switcher|tabs\b)|\.k2b-spotlight-button\[data-variant=["']?sidebar["']?\]/;

describe("navigation truncation contract", () => {
  test(message, () => {
    for (const rule of [...readShippedCssRules(import.meta.dir), ...builtRules].filter((rule) => navigation.test(rule.selector))) {
      const declarations = cssDeclarations(rule.body);
      const context = `${message}: ${rule.file} ${rule.context} ${rule.selector}`;
      expect(declarations.get("text-overflow")?.some((value) => /\bellipsis\b/i.test(value)) ?? false, context).toBe(false);
      expect(declarations.has("-webkit-line-clamp"), context).toBe(false);
      expect(declarations.has("line-clamp"), context).toBe(false);
    }
  });

  test("ships masks, overflow detection, a fallback that dims nothing, and an RTL fade", () => {
    // One line overflows only sideways; a block timeline there would fire on glyphs that reach past a tight line box.
    for (const [utility, timeline, fallback] of [
      ["k2b-truncate-fade", /^scroll\(self inline\)$/, "text-overflow"],
      ["k2b-truncate-fade-lines", /^scroll\(self inline\),\s*scroll\(self block\)$/, "-webkit-line-clamp"],
    ] as const) {
      const rules = builtRules.filter((rule) => new RegExp(`\\.${utility}(?![\\w-])`).test(rule.selector));
      expect(
        rules.some((rule) => cssDeclarations(rule.body).has("mask-image")),
        message,
      ).toBe(true);
      // Without detection a label counts as fitting, so an engine without scroll timelines never dims a label that fits.
      const base = rules.find((rule) => rule.context === "" && cssDeclarations(rule.body).has("--k2b-truncate-fade-on"));
      expect(base && cssDeclarations(base.body).get("--k2b-truncate-fade-on"), message).toEqual(["0"]);
      const detection = rules.find(
        (rule) => /@supports \(animation-timeline:\s*scroll\(\)\)/.test(rule.context) && new RegExp(`\\.${utility}$`).test(rule.selector),
      );
      expect(detection, message).toBeDefined();
      const declarations = cssDeclarations(detection!.body);
      expect(declarations.get("animation-timeline")?.join(","), message).toMatch(timeline);
      expect(declarations.get("animation")?.join(","), message).toContain("k2b-truncate-fade");
      const withoutTimelines = rules.find(
        (rule) =>
          /@supports\s+not \(animation-timeline:\s*scroll\(\)\)/.test(rule.context) && new RegExp(`\\.${utility}$`).test(rule.selector),
      );
      expect(withoutTimelines && cssDeclarations(withoutTimelines.body).has(fallback), message).toBe(true);
      expect(
        rules.some(
          (rule) => /\[dir=["']?rtl["']?\]/.test(rule.selector) && /linear-gradient\(90deg|linear-gradient\(to right/.test(rule.body),
        ),
        message,
      ).toBe(true);
    }
    expect(css, message).toContain("@keyframes k2b-truncate-fade");
    expect(css, message).toMatch(/@property --k2b-truncate-fade-on\{[^}]*inherits:false[^}]*initial-value:0/);
  });
});
