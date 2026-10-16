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
      const rule = rules.find((candidate) => candidate.selector === fallback + selector && candidate.context === hoverPointer);
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
    const hides = rules.filter((rule) => {
      const declarations = cssDeclarations(rule.body);
      return (
        // Object-row counts yield to overlaid actions; they are not actions themselves.
        !rule.selector.endsWith(" .k2b-app-workspace__sidebar-item-meta") &&
        rowAction.test(rule.selector) &&
        (declarations.get("opacity")?.includes("0") ||
          declarations.get("visibility")?.includes("hidden") ||
          declarations.get("pointer-events")?.includes("none"))
      );
    });
    for (const rule of hides) {
      const isMedia = rule.selector.startsWith(fallback);
      expect(isMedia || rule.selector.startsWith(trackpad), rule.selector).toBe(true);
      expect(rule.context.includes(hoverPointer), rule.selector).toBe(isMedia);
      const twin = rules.find(
        (candidate) =>
          candidate.file === rule.file &&
          candidate.selector ===
            (isMedia ? trackpad + rule.selector.slice(fallback.length) : fallback + rule.selector.slice(trackpad.length)) &&
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
    // Only paint may depend on mode; boxes stay reserved. The sidebar fade inset only moves a mask gradient.
    const paint = ["opacity", "visibility", "pointer-events", "transition", "--k2b-sidebar-item-fade-inset"];
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
      ".k2b-ui .k2b-detail-panel__section-header h3",
      ".k2b-ui .k2b-detail-panel__section-title",
      ".k2b-ui .k2b-discussion__header :is(h2, h3)",
      ".k2b-ui .k2b-content-structured-data__title",
    ]) {
      const label = declarations(selector);
      expect(label.get("text-transform")).toEqual(["none"]);
      expect(label.get("letter-spacing")).toEqual(["normal"]);
      expect(Number(label.get("font-weight")?.[0])).toBeLessThanOrEqual(600);
    }
  });

  test("reveals workspace scrollbars for pointer and keyboard use without changing their geometry", () => {
    const rules = readShippedCssRules(stylesDir);
    const scrollers = [".k2b-ui .k2b-app-workspace__sidebar-body", ".k2b-ui .k2b-chat-timeline__viewport"];
    const finePointer = "@media (hover: hover) and (pointer: fine)";
    const forcedColors = "@media (forced-colors: active)";
    const declarations = (selector: string, context: string) => {
      const rule = rules.find((candidate) => candidate.selector === selector && candidate.context === context);
      expect(rule, `${context} ${selector}`).toBeDefined();
      return cssDeclarations(rule!.body);
    };

    for (const selector of scrollers) {
      const idle = declarations(selector, finePointer);
      expect(idle.get("scrollbar-color")).toEqual(["transparent transparent"]);
      expect(idle.has("scrollbar-width")).toBe(false);
      expect(declarations(`${selector}::-webkit-scrollbar-thumb`, finePointer).get("background")).toEqual(["transparent"]);
      expect(declarations(`${selector}:is(:hover, :focus-within)`, finePointer).get("scrollbar-color")?.[0]).not.toStartWith("transparent");
      expect(declarations(`${selector}:is(:hover, :focus-within)::-webkit-scrollbar-thumb`, finePointer).get("background")?.[0]).not.toBe(
        "transparent",
      );
      expect(declarations(selector, forcedColors).get("scrollbar-color")).toEqual(["auto"]);
      expect(declarations(`${selector}::-webkit-scrollbar-thumb`, forcedColors).get("background")).toEqual(["revert"]);
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

  test("overlays DataTable scrollbars and keeps dark scrollbars quieter", () => {
    const rules = readShippedCssRules(stylesDir);
    const finePointer = "@media (hover: hover) and (pointer: fine)";
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
    expect(shippedCss).toContain("--k2b-scrollbar-thumb: rgb(113 113 122 / 0.55)");
    expect(shippedCss).toContain("background: var(--k2b-scrollbar-thumb-hover)");
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
    expect(index).not.toContain("@layer base {");
    expect(index).toMatch(
      /\.k2b-ui,\s*\.k2b-ui \*,\s*\.k2b-ui \*::before,\s*\.k2b-ui \*::after \{\s*box-sizing: border-box;[\s\S]*?\.k2b-ui :where\(button, input, select, textarea\) \{\s*font: inherit;/,
    );
  });
});
