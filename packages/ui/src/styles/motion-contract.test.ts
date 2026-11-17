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
  "--k2b-motion-morph": "280ms",
  "--k2b-motion-stack": "400ms",
  "--k2b-motion-celebrate": "600ms",
  "--k2b-fresh-fade": "1600ms",
  // Work in progress (concept gustav-ui-neu, 6a): every moment follows a change of state; only "running" loops.
  "--k2b-motion-glide": "380ms",
  "--k2b-motion-check": "260ms",
  "--k2b-motion-ink": "240ms",
  "--k2b-motion-progress": "400ms",
  "--k2b-motion-fold": "280ms",
  "--k2b-motion-spin": "1100ms",
  "--k2b-motion-pass": "300ms",
  "--k2b-motion-glow": "1000ms",
  "--k2b-motion-count": "500ms",
  "--k2b-motion-arrive": "460ms",
  "--k2b-motion-ring-out": "1100ms",
  "--k2b-motion-busy": "1300ms",
  "--k2b-motion-switch-on": "340ms",
  "--k2b-motion-pulse": "1100ms",
  "--k2b-motion-settle": "300ms",
  "--k2b-motion-enter-row": "420ms",
  "--k2b-motion-think": "2200ms",
  // Feinschliff v3, section 1: a changing activity word fades out, then the next fades in, and stands its hold.
  "--k2b-motion-word-out": "120ms",
  "--k2b-motion-word-in": "160ms",
  "--k2b-motion-word-hold": "2400ms",
};
/** How far a surface travels as it arrives or leaves. */
const shifts = {
  "--k2b-shift-in": "8px",
  "--k2b-shift-out": "4px",
};
const curves = {
  "--k2b-ease-out": "cubic-bezier(0.23, 1, 0.32, 1)",
  "--k2b-ease-spring": "cubic-bezier(0.34, 1.56, 0.64, 1)",
  "--k2b-ease-morph": "cubic-bezier(0.2, 0, 0, 1)",
  "--k2b-ease-glide": "cubic-bezier(0.3, 0.7, 0.2, 1)",
  "--k2b-ease-pop": "cubic-bezier(0.2, 1.15, 0.4, 1)",
  "--k2b-ease-pop-strong": "cubic-bezier(0.2, 1.4, 0.4, 1)",
  "--k2b-ease-rise": "cubic-bezier(0.2, 0.8, 0.2, 1)",
  "--k2b-ease-settle": "ease",
  "--k2b-ease-in": "ease-in",
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
    for (const [token, value] of Object.entries({ ...durations, ...curves, ...shifts })) expect(root.get(token)).toEqual([value]);
  });

  for (const variant of ["OS", "host"] as const) {
    const context = variant === "OS" ? "@media (prefers-reduced-motion: reduce)" : "";
    const host = variant === "host" ? 'html[data-k2b-motion="reduced"] ' : "";
    test(`${variant} reduction makes durations instant and keeps the curves`, () => {
      const root = declarations(`${host}.k2b-ui`, context);
      for (const token of Object.keys(durations)) expect(root.get(token)).toEqual(["0ms"]);
      for (const token of Object.keys(shifts)) expect(root.get(token)).toEqual(["0px"]);
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

  describe("dialogs rise in and fade out", () => {
    const shipped = readShippedCssRules(import.meta.dir);
    const rule = (selector: string, context = "") => {
      const bodies = shipped.filter((candidate) => candidate.selector === selector && candidate.context === context);
      expect(bodies.length, `${context} ${selector}`).toBeGreaterThan(0);
      return cssDeclarations(bodies.map((candidate) => candidate.body).join(";"));
    };
    const transition = (declarations: Map<string, string[]>) => declarations.get("transition")?.join(",").replace(/\s+/g, " ") ?? "";
    const frames = {
      dialog: [".k2b-ui .k2b-dialog:not(.k2b-bottom-sheet-frame)", ""],
      "adaptive sheet from 48rem": [".k2b-ui .k2b-dialog.k2b-bottom-sheet-frame.is-adaptive", "@media (min-width: 48rem)"],
    } as const;

    for (const [name, [frame, context]] of Object.entries(frames)) {
      test(`${name}: leaves over the fast time by 4 px, arrives over the base time by 8 px`, () => {
        const closed = rule(frame, context);
        expect(closed.get("opacity")).toEqual(["0"]);
        expect(closed.get("translate")).toEqual(["0 var(--k2b-dialog-shift-out)"]);
        for (const property of ["opacity", "translate"])
          expect(transition(closed)).toContain(`${property} var(--k2b-motion-fast) var(--k2b-ease-out)`);
        // The exit keeps the frame in the top layer only where the engine has `overlay`; elsewhere it closes at once.
        expect(transition(closed)).not.toContain("overlay");
        const exit = rule(frame, [context, "@supports (overlay: auto)"].filter(Boolean).join(" > "));
        for (const property of ["overlay", "display"])
          expect(transition(exit)).toContain(`${property} var(--k2b-motion-fast) allow-discrete`);
        const open = rule(`${frame}[open]`, context);
        expect(open.get("opacity")).toEqual(["1"]);
        expect(open.get("translate")).toEqual(["0 0"]);
        expect(open.get("transition-duration")).toEqual(["var(--k2b-motion-base)"]);
        const start = rule(`${frame}[open]:not([data-no-enter])`, [context, "@starting-style"].filter(Boolean).join(" > "));
        expect(start.get("opacity")).toEqual(["0"]);
        expect(start.get("translate")).toEqual(["0 var(--k2b-dialog-shift-in)"]);
        expect(rule(`${frame}::backdrop`, context).get("opacity")).toEqual(["0"]);
        expect(rule(`${frame}[open]::backdrop`, context).get("opacity")).toEqual(["1"]);
      });
    }

    test("a closing frame and its veil take no clicks", () => {
      for (const selector of [".k2b-ui .k2b-dialog:not([open])", ".k2b-ui .k2b-dialog:not([open])::backdrop"])
        expect(rule(selector).get("pointer-events")).toEqual(["none"]);
    });

    test("large surfaces only fade", () => {
      const large = rule(".k2b-ui .k2b-dialog:is(.k2b-dialog--full, .is-workspace)");
      expect(large.get("--k2b-dialog-shift-in")).toEqual(["0px"]);
      expect(large.get("--k2b-dialog-shift-out")).toEqual(["0px"]);
      // The Lightbox fades in only: its owner removes it the moment it closes.
      const lightbox = rule(".k2b-ui .k2b-lightbox[open]");
      expect(transition(lightbox)).toBe("opacity var(--k2b-motion-base) var(--k2b-ease-out)");
      expect(lightbox.has("translate")).toBe(false);
    });

    test("a phone sheet keeps its own motion and an adaptive dialog has no second entrance", () => {
      // The adaptive sheet's old keyframes moved it by transform as well; together with the rise it travelled 16 px.
      expect(shipped.some((candidate) => /k2b-sheet-dialog-enter/.test(candidate.body))).toBe(false);
      expect(rule(".k2b-ui .k2b-dialog.k2b-bottom-sheet-frame.is-adaptive", "@media (min-width: 48rem)").get("animation")).toEqual([
        "none",
      ]);
    });
  });
});
