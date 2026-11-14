import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cssDeclarations, readShippedCssRules, shippedStyleFiles } from "./css-contract-test-helpers";

const stylesDir = import.meta.dir;
const styleSources = shippedStyleFiles(stylesDir).map((file) => ({
  file,
  source: readFileSync(resolve(stylesDir, file), "utf8"),
}));
const shippedCss = styleSources.map(({ source }) => source).join("\n");

describe("@k2b/ui stylesheet hygiene", () => {
  test("pairs input-mode rest rules and keeps the current row's actions", () => {
    const rules = readShippedCssRules(stylesDir);
    const hoverPointer = "@media (any-hover: hover)";
    const fallback = ':where(html:not([data-k2b-input="touch"])) ';
    const trackpad = ':where(html[data-k2b-input="trackpad"]) ';
    // Where any pointer can hover, sidebar row actions overlay the label and counts. Touch input keeps their reveal
    // set (hover, focus, current row, open menu); showing them on every row would hide every row's text and counts.
    const overlaid: ReadonlySet<string> = new Set([
      '.k2b-ui .k2b-app-workspace__sidebar-item-actions[data-visibility="hover"]',
      '.k2b-ui .k2b-app-workspace__sidebar-item > .k2b-app-workspace__sidebar-item-action[data-visibility="hover"]',
    ]);
    const restPrefix = (selector: string) => (overlaid.has(selector) ? "" : fallback);
    for (const [selector, property, value] of [
      [".k2b-ui .k2b-app-workspace__sidebar-section-actions", "opacity", "0"],
      ['.k2b-ui .k2b-app-workspace__sidebar-item-meta[data-visibility="hover"]', "visibility", "hidden"],
      ['.k2b-ui .k2b-app-workspace__sidebar-item-actions[data-visibility="hover"]', "visibility", "hidden"],
      ['.k2b-ui .k2b-app-workspace__sidebar-item > .k2b-app-workspace__sidebar-item-action[data-visibility="hover"]', "opacity", "0"],
      [".k2b-ui .k2b-detail-panel__action-secondary", "opacity", "0"],
      [".k2b-ui .k2b-detail-panel__action-menu-trigger", "opacity", "0"],
      ['.k2b-ui .k2b-discussion__item-actions[data-visibility="progressive"]', "opacity", "0"],
      ['.k2b-ui .k2b-description-list[data-action-visibility="progressive"] .k2b-description-list__action', "opacity", "0"],
      [".k2b-ui .k2b-tabs__list .k2b-tabs__close", "opacity", "0"],
      [".k2b-ui .k2b-progressive-action", "opacity", "0"],
    ] as const) {
      const rule = rules.find((candidate) => candidate.selector === restPrefix(selector) + selector && candidate.context === hoverPointer);
      expect(rule, selector).toBeDefined();
      expect(cssDeclarations(rule!.body).get(property)).toEqual([value]);
      const twin = rules.find((candidate) => candidate.selector === trackpad + selector && candidate.context === "");
      expect(twin, selector).toBeDefined();
      expect(cssDeclarations(twin!.body)).toEqual(cssDeclarations(rule!.body));
    }

    const rowAction =
      /sidebar-section-actions|sidebar-item-actions|sidebar-item-action\b|sidebar-item-meta\[data-visibility|detail-panel__action-secondary|detail-panel__action-menu-trigger|discussion__item-actions|description-list__action|tabs__close|progressive-action/;
    // A primary-pointer query misses a tablet with a mouse, whether it hides or shows the actions.
    const primaryPointer = /\((?:hover:\s*(?:hover|none)|pointer:\s*(?:fine|coarse))\)/;
    expect(rules.filter((rule) => rowAction.test(rule.selector) && primaryPointer.test(rule.context))).toEqual([]);
    // Without a coarse pointer a preview opens on hover, so its button and the action before it share one slot and
    // only one of them shows. That follows the pointer capability, never the input mode: a pen on such a screen
    // records touch and would otherwise show both buttons in one place.
    // `data-preview-focus` is the workspace controller's mark for the preview's keyboard focus.
    const previewSlot = (rule: (typeof rules)[number]) =>
      /sidebar-preview-trigger|\[data-preview-focus\]/.test(rule.selector) && rule.context.includes("not all and (any-pointer: coarse)");
    const previewSlotHides = rules.filter((rule) => previewSlot(rule) && cssDeclarations(rule.body).get("opacity")?.includes("0"));
    expect(previewSlotHides.length).toBeGreaterThanOrEqual(2);
    for (const rule of previewSlotHides) expect(rule.selector, rule.selector).not.toContain("data-k2b-input");
    const hides = rules.filter((rule) => {
      const declarations = cssDeclarations(rule.body);
      return (
        !previewSlot(rule) &&
        // Object-row counts yield to overlaid actions; they are not actions themselves.
        !rule.selector.endsWith(" .k2b-app-workspace__sidebar-item-meta") &&
        rowAction.test(rule.selector) &&
        (declarations.get("opacity")?.includes("0") ||
          declarations.get("visibility")?.includes("hidden") ||
          declarations.get("pointer-events")?.includes("none"))
      );
    });
    for (const rule of hides) {
      const isMedia = !rule.selector.startsWith(trackpad);
      const base = isMedia ? rule.selector.replace(fallback, "") : rule.selector.slice(trackpad.length);
      expect(rule.selector, rule.selector).toBe(isMedia ? restPrefix(base) + base : trackpad + base);
      expect(rule.context.includes(hoverPointer), rule.selector).toBe(isMedia);
      const twin = rules.find(
        (candidate) =>
          candidate.file === rule.file &&
          candidate.selector === (isMedia ? trackpad + base : restPrefix(base) + base) &&
          candidate.context ===
            (isMedia
              ? rule.context
                  .split(" > ")
                  .filter((context) => context !== hoverPointer)
                  .join(" > ")
              : [rule.context, hoverPointer].filter(Boolean).join(" > ")),
      );
      expect(twin, rule.selector).toBeDefined();
      expect(cssDeclarations(twin!.body)).toEqual(cssDeclarations(rule.body));
    }
    // Only paint may depend on mode; boxes stay reserved. The sidebar fade and object-row counts follow the overlaid
    // actions, never the mode, so touch input cannot hide every row's text.
    const paint = ["opacity", "visibility", "pointer-events", "transition"];
    expect(rules.filter((rule) => /data-k2b-input/.test(rule.selector) && /sidebar-item-(?:main|meta)$/.test(rule.selector))).toEqual([]);
    for (const rule of rules.filter((rule) => /data-k2b-(?:input|kbd)/.test(rule.selector))) {
      const declarations = cssDeclarations(rule.body);
      expect(
        [...declarations.keys()].every((key) => paint.includes(key)),
        rule.selector,
      ).toBe(true);
      for (const transition of declarations.get("transition") ?? []) expect(transition).toStartWith("opacity ");
    }

    const reveal = rules.find(
      (rule) =>
        rule.context === "" &&
        rule.selector.endsWith(' .k2b-app-workspace__sidebar-item-actions[data-visibility="hover"]') &&
        rule.selector.includes(".k2b-app-workspace__sidebar-item:is("),
    );
    expect(reveal).toBeDefined();
    expect(reveal!.selector).toContain(".is-active");
    expect(reveal!.selector).toContain(':has(> [aria-current="page"])');
    expect(cssDeclarations(reveal!.body).get("visibility")).toEqual(["visible"]);
  });

  test("keeps inspector and navigation section labels quiet and sentence-case", () => {
    const rules = readShippedCssRules(stylesDir);
    const declarations = (selector: string) => {
      const rule = rules.find((candidate) => candidate.selector === selector && candidate.context === "");
      expect(rule, selector).toBeDefined();
      return cssDeclarations(rule!.body);
    };

    const sidebarSelector = [
      ".k2b-ui .k2b-app-workspace__sidebar-section-header > h2",
      ".k2b-ui .k2b-app-workspace__sidebar-section > h2",
    ].find((selector) => rules.some((candidate) => candidate.selector === selector && candidate.context === ""));
    expect(sidebarSelector).toBeDefined();

    for (const selector of [
      sidebarSelector!,
      ".k2b-ui .k2b-detail-panel__summary-header h3",
      ".k2b-ui .k2b-section__title",
      ".k2b-ui .k2b-section__part-title",
      ".k2b-ui .k2b-content-structured-data__title",
    ]) {
      const label = declarations(selector);
      expect(label.get("text-transform")).toEqual(["none"]);
      expect(label.get("letter-spacing")).toEqual(["normal"]);
      expect(Number(label.get("font-weight")?.[0])).toBeLessThanOrEqual(600);
    }
  });

  test("draws one scrollbar everywhere: no track, a 4px thumb that widens to 6px inside a fixed 0.5rem", () => {
    const rules = readShippedCssRules(stylesDir);
    const declarations = (selector: string, context: string) => {
      const rule = rules.find((candidate) => candidate.selector === selector && candidate.context === context);
      expect(rule, `${context} ${selector}`).toBeDefined();
      return cssDeclarations(rule!.body);
    };
    // Every element inside `.k2b-ui` and the document hosting it, matched directly: a direct match beats an inherited value.
    const every = ":where(:root:has(> .k2b-ui), .k2b-ui, .k2b-ui *)";
    const webkit = "@layer base > @media (pointer: fine) and (forced-colors: none)";
    const scrollbar = declarations(`${every}::-webkit-scrollbar`, webkit);
    expect([scrollbar.get("width"), scrollbar.get("height")]).toEqual([["0.5rem"], ["0.5rem"]]);
    expect(declarations(`${every}::-webkit-scrollbar-track`, webkit).get("background")).toEqual(["transparent"]);
    expect(declarations(`${every}::-webkit-scrollbar-corner`, webkit).get("background")).toEqual(["transparent"]);
    expect(declarations(`${every}::-webkit-scrollbar-button`, webkit).get("display")).toEqual(["none"]);
    const thumb = declarations(`${every}::-webkit-scrollbar-thumb`, webkit);
    expect(thumb.get("border")).toEqual(["0.125rem solid transparent"]);
    expect(thumb.get("background")).toEqual(["var(--k2b-scrollbar-thumb)"]);
    for (const state of ["hover", "active"]) {
      const widened = declarations(`${every}::-webkit-scrollbar-thumb:${state}`, webkit);
      expect(widened.get("border-width")).toEqual(["0.0625rem"]);
      expect(widened.get("background")).toEqual(["var(--k2b-scrollbar-thumb-hover)"]);
    }
    // Chromium ignores ::-webkit-scrollbar beside either property, so only engines without it receive them.
    const firefox = declarations(every, "@layer base > @supports not selector(::-webkit-scrollbar) > @media (forced-colors: none)");
    expect(firefox.get("scrollbar-width")).toEqual(["thin"]);
    expect(firefox.get("scrollbar-color")).toEqual(["var(--k2b-scrollbar-thumb) transparent"]);
    const tokens = (selector: string) =>
      rules
        .filter((rule) => rule.selector === selector && rule.context === "")
        .map((rule) => cssDeclarations(rule.body))
        .find((found) => found.has("--k2b-scrollbar-thumb"))!;
    const light = tokens(".k2b-ui");
    expect(light.get("--k2b-scrollbar-thumb")).toEqual(["color-mix(in srgb, var(--k2b-neutral-500, #71717a) 45%, transparent)"]);
    expect(light.get("--k2b-scrollbar-thumb-hover")).toEqual(["color-mix(in srgb, var(--k2b-neutral-500, #71717a) 80%, transparent)"]);
    const dark = tokens(".dark .k2b-ui");
    expect(dark.get("--k2b-scrollbar-thumb")).toEqual(["color-mix(in srgb, var(--k2b-neutral-400, #a1a1aa) 35%, transparent)"]);
    expect(dark.get("--k2b-scrollbar-thumb-hover")).toEqual(["color-mix(in srgb, var(--k2b-neutral-400, #a1a1aa) 70%, transparent)"]);
  });

  test("reveals workspace scrollbars for pointer and keyboard use without changing their geometry", () => {
    const rules = readShippedCssRules(stylesDir);
    // `k2b-quiet-scrollbar` is the public class for an application's own scrollers.
    const scrollers = [".k2b-ui .k2b-app-workspace__sidebar-body", ".k2b-ui .k2b-chat-timeline__viewport", ".k2b-ui .k2b-quiet-scrollbar"];
    const quiet = "@layer base > @media (hover: hover) and (pointer: fine) and (forced-colors: none)";
    const firefox = `${quiet} > @supports not selector(::-webkit-scrollbar)`;
    const declarations = (selector: string, context: string) => {
      const rule = rules.find((candidate) => candidate.selector === selector && candidate.context === context);
      expect(rule, `${context} ${selector}`).toBeDefined();
      return cssDeclarations(rule!.body);
    };

    for (const selector of scrollers) {
      const idle = declarations(`${selector}::-webkit-scrollbar-thumb`, quiet);
      expect([...idle.keys()]).toEqual(["background"]);
      expect(idle.get("background")).toEqual(["transparent"]);
      for (const reveal of ["hover", "focus-within"]) {
        expect(declarations(`${selector}:${reveal}::-webkit-scrollbar-thumb`, quiet).get("background")).toEqual([
          "var(--k2b-scrollbar-thumb)",
        ]);
        // WebKit repaints a styled scrollbar only when the scroller's own style changes.
        expect([...declarations(`${selector}:${reveal}`, quiet).keys()]).toEqual(["--k2b-scrollbar-revealed"]);
        expect(declarations(`${selector}:${reveal}`, firefox).get("scrollbar-color")).toEqual(["var(--k2b-scrollbar-thumb) transparent"]);
      }
      expect(declarations(`${selector}::-webkit-scrollbar-thumb:hover`, quiet).get("background")).toEqual([
        "var(--k2b-scrollbar-thumb-hover)",
      ]);
      const firefoxIdle = declarations(selector, firefox);
      expect(firefoxIdle.get("scrollbar-color")).toEqual(["transparent transparent"]);
      expect(firefoxIdle.has("scrollbar-width")).toBe(false);
    }
  });

  test("gives AppOverview the sidebar-first page inset and the application accent", () => {
    const rules = readShippedCssRules(stylesDir);
    const declarations = (selector: string) => {
      const rule = rules.find((candidate) => candidate.selector === selector && candidate.context === "");
      expect(rule, selector).toBeDefined();
      return cssDeclarations(rule!.body);
    };

    const page = declarations(".k2b-ui .k2b-app-overview");
    expect(page.get("--k2b-app-overview-inset")).toEqual(["clamp(1rem, 3vw, 2.5rem)"]);
    expect(page.get("padding")).toEqual(["var(--k2b-app-overview-inset)"]);
    expect(declarations(".k2b-ui .k2b-app-overview__icon").get("color")).toEqual(["var(--k2b-app-workspace-active)"]);
  });

  test("overlays DataTable scrollbars with the shared thumb", () => {
    const rules = readShippedCssRules(stylesDir);
    const finePointer = "@media (hover: hover) and (pointer: fine) and (forced-colors: none)";
    const forcedColors = "@media (forced-colors: active)";
    const declarations = (selector: string, context = "") => {
      const rule = rules.find((candidate) => candidate.selector === selector && candidate.context === context);
      expect(rule, `${context} ${selector}`).toBeDefined();
      return cssDeclarations(rule!.body);
    };

    expect(declarations(".k2b-ui .k2b-table-shell").get("overflow")).toEqual(["hidden"]);
    expect(declarations(".k2b-ui .k2b-table-wrap").get("overflow")).toEqual(["auto"]);
    expect(
      declarations('.k2b-ui .k2b-table-shell[data-scrollbar-enhanced="true"] > .k2b-table-wrap', finePointer).get("scrollbar-width"),
    ).toEqual(["none"]);
    expect(
      declarations(
        '.k2b-ui .k2b-table-shell[data-scrollbar-enhanced="true"] > .k2b-data-table__scrollbar[data-overflow="true"]',
        finePointer,
      ).get("display"),
    ).toEqual(["block"]);
    expect(declarations(".k2b-ui .k2b-data-table__scrollbar", forcedColors).get("display")).toEqual(["none !important"]);
    // The overlay draws the shared thumb: 4px of its 0.5rem lane at rest, 6px under the pointer.
    const thumb = declarations(".k2b-ui .k2b-data-table__scrollbar > span");
    expect([thumb.get("border"), thumb.get("background")]).toEqual([["0.125rem solid transparent"], ["var(--k2b-scrollbar-thumb)"]]);
    const hovered = declarations(".k2b-ui .k2b-data-table__scrollbar:hover > span", finePointer);
    expect([hovered.get("border-width"), hovered.get("background")]).toEqual([["0.0625rem"], ["var(--k2b-scrollbar-thumb-hover)"]]);
  });

  test("does not restore selectors and tokens proven dead during migration", () => {
    const removed = [
      "k2b-button--secondary",
      "k2b-switch__content",
      "k2b-app-overview__panel-content",
      "data-k2b-tone",
      "k2b-progress-indeterminate",
      "k2b-pagination__edge",
      ".k2b-markdown ",
      ".k2b-structured-data ",
      ".k2b-calendar__",
      ".k2b-file-view ",
      "--k2b-control-height",
      "--k2b-font-condensed",
      "--k2b-danger:",
    ];

    for (const token of removed) expect(shippedCss, token).not.toContain(token);
  });

  test("keeps every declared keyframe reachable and media blocks non-empty", () => {
    const names = [...shippedCss.matchAll(/@(?:-webkit-)?keyframes\s+([\w-]+)/g)].map((match) => match[1]!);
    const unused = names.filter((name) => shippedCss.match(new RegExp(`\\b${name}\\b`, "g"))?.length === 1);
    const emptyMedia = styleSources
      .filter(({ source }) => /@media[^{}]*\{\s*\}/s.test(source.replace(/\/\*[\s\S]*?\*\//g, "")))
      .map(({ file }) => file);

    expect(names.length).toBeGreaterThan(0);
    expect(unused).toEqual([]);
    expect(emptyMedia).toEqual([]);
  });

  test("keeps portal, motion and semantic status fixes explicit", () => {
    const index = readFileSync(resolve(stylesDir, "index.css"), "utf8");
    const surfaces = readFileSync(resolve(stylesDir, "surfaces-widgets-parity.css"), "utf8");
    const plex = readFileSync(resolve(stylesDir, "../fonts/plex.css"), "utf8");

    expect(index).toMatch(/\.k2b-ui \.k2b-ui-portal\s*\{\s*display:\s*contents;\s*\}/);
    expect(index).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.k2b-ui \.k2b-chat-activity__chevron,[\s\S]*?\.k2b-ui \.k2b-chat-composer,[\s\S]*?\.k2b-ui \.k2b-switch__thumb\s*\{\s*transition:\s*none;/,
    );
    expect(surfaces).toMatch(
      /\.k2b-status-badge\[data-tone="degraded"\] \.k2b-status-badge__dot\s*\{\s*background:\s*var\(--k2b-warning-500\);/,
    );
    // Notices keep neutral ink: the tone only tints the surface and the meta pill.
    expect(surfaces).toContain(
      '.k2b-ui .k2b-notice-card[data-tone="info"] { --k2b-notice-ink: var(--k2b-info-text); --k2b-notice-surface: var(--k2b-info-surface); }',
    );
    expect(surfaces).toContain(
      '.k2b-ui .k2b-notice-card[data-tone="success"] { --k2b-notice-ink: var(--k2b-success-text); --k2b-notice-surface: var(--k2b-success-surface); }',
    );
    expect(surfaces).toMatch(/\.k2b-ui \.k2b-notice-card__title \{[^}]*color: var\(--k2b-text\);/);
    expect(plex).not.toContain("ibm-plex-sans-condensed");
  });

  test("keeps normalization scoped without owning a global base layer", () => {
    const index = readFileSync(resolve(stylesDir, "index.css"), "utf8");

    expect(index).toContain("@layer properties, theme, base, components, utilities;");
    // The base layer holds only the shared scrollbar, so a hidden scrollbar from a utility wins over it. Every rule
    // there stays scoped to `.k2b-ui` and the document that hosts it.
    const base = readShippedCssRules(stylesDir).filter((rule) => rule.context.startsWith("@layer base"));
    expect(base.length).toBeGreaterThan(0);
    expect(base.filter((rule) => !rule.selector.includes(".k2b-ui") || !/scrollbar/.test(rule.selector + rule.body))).toEqual([]);
    expect(index).toMatch(
      /\.k2b-ui,\s*\.k2b-ui \*,\s*\.k2b-ui \*::before,\s*\.k2b-ui \*::after \{\s*box-sizing: border-box;[\s\S]*?\.k2b-ui :where\(button, input, select, textarea\) \{\s*font: inherit;/,
    );
  });
});
