import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cssDeclarations, parseCssRules, readShippedCssRules } from "./css-contract-test-helpers";

const source = readFileSync(resolve(import.meta.dir, "index.css"), "utf8");
const rules = parseCssRules("index.css", source);
const durations = {
  "--k2b-motion-fast": "120ms",
  "--k2b-motion-base": "180ms",
  "--k2b-motion-sheet": "220ms",
  "--k2b-motion-celebrate": "600ms",
  "--k2b-fresh-fade": "1600ms",
};
const curves = {
  "--k2b-ease-out": "cubic-bezier(0.23, 1, 0.32, 1)",
  "--k2b-ease-spring": "cubic-bezier(0.34, 1.56, 0.64, 1)",
};
/** Declarations of every rule with this selector in this context, in source order. */
const declarations = (selector: string, context = "") => {
  const bodies = rules.filter((rule) => rule.selector === selector && rule.context === context).map((rule) => rule.body);
  expect(bodies.length, `${context} ${selector}`).toBeGreaterThan(0);
  return cssDeclarations(bodies.join(";"));
};

describe("@k2b/ui motion contract", () => {
  test("provides one vocabulary for duration and easing", () => {
    const root = declarations(".k2b-ui");
    for (const [token, value] of Object.entries({ ...durations, ...curves })) expect(root.get(token)).toEqual([value]);
  });

  for (const variant of ["OS", "host"] as const) {
    const context = variant === "OS" ? "@media (prefers-reduced-motion: reduce)" : "";
    const host = variant === "host" ? 'html[data-k2b-motion="reduced"] ' : "";
    test(`${variant} reduction makes durations instant and keeps the curves`, () => {
      const root = declarations(`${host}.k2b-ui`, context);
      for (const token of Object.keys(durations)) expect(root.get(token)).toEqual(["0ms"]);
      for (const token of Object.keys(curves)) expect(root.has(token)).toBe(false);
    });

    test(`${variant} reduction overrides every transition, animation, and scroll inside .k2b-ui`, () => {
      for (const scope of [".k2b-ui", ".k2b-ui *"]) {
        for (const part of ["", "::before", "::after", "::backdrop"]) {
          const state = declarations(`${host}${scope}${part}`, context);
          for (const property of ["transition-duration", "transition-delay", "animation-duration", "animation-delay"])
            expect(state.get(property)).toEqual(["0s !important"]);
          expect(state.get("scroll-behavior")).toEqual(["auto !important"]);
        }
      }
    });
  }

  test("host reduction repeats every reduced-motion rule that changes more than timing", () => {
    // Timing-only rules and tokens are covered by the generic rules above. A rule that
    // swaps presentation (a muted track, a still icon, a stacking order) needs
    // the same declarations for the attribute, or JS and CSS disagree.
    const shipped = readShippedCssRules(import.meta.dir);
    const reduced = "prefers-reduced-motion: reduce";
    const presentation = shipped.filter(
      (rule) =>
        rule.context.includes(reduced) &&
        [...cssDeclarations(rule.body).keys()].some((property) => !/^(?:--k2b-|transition|animation|scroll-behavior)/.test(property)),
    );
    expect(presentation.length).toBeGreaterThan(0);
    for (const rule of presentation) {
      const context = rule.context
        .split(" > ")
        .filter((part) => !part.includes(reduced))
        .join(" > ");
      const twins = shipped
        .filter(
          (candidate) => candidate.selector === `:where(html[data-k2b-motion="reduced"]) ${rule.selector}` && candidate.context === context,
        )
        .map((twin) => cssDeclarations(twin.body));
      expect(twins, `${rule.file}: ${rule.selector}`).toContainEqual(cssDeclarations(rule.body));
    }
  });
});
