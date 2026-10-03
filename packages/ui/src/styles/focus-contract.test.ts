import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { cssDeclarations, focusSignalCount, isFocusSelector, readShippedCssRules, shippedStyleFiles } from "./css-contract-test-helpers";

const stylesDir = import.meta.dir;
const rules = readShippedCssRules(stylesDir);
const hasVisibleValue = (values: string[] | undefined) =>
  values?.some((value) => !/^(?:none|0(?:px)?|transparent|initial|inherit|unset)(?:\s*!important)?$/i.test(value)) ?? false;

describe("@k2b/ui focus and color contract", () => {
  test("owns its body typography without styling the document body", async () => {
    const css = await Bun.file(resolve(stylesDir, "index.css")).text();
    const root = css.match(/\.k2b-ui\s*\{([\s\S]*?)\}/)?.[1] ?? "";

    expect(root).toContain("font-size: 0.9375rem;");
    expect(root).toContain("font-weight: 400;");
    expect(css).not.toMatch(/(?:^|\})\s*body\s*\{/);
  });

  test("uses a clear general focus color in light and dark themes", async () => {
    const css = await Bun.file(resolve(stylesDir, "index.css")).text();

    expect(css).toContain("--k2b-focus-ring: var(--k2b-accent-500);");
    expect(css).toContain("--k2b-focus-ring: var(--k2b-accent-400);");
  });

  test("sizes and places every focus ring with the shared tokens", async () => {
    const css = await Bun.file(resolve(stylesDir, "index.css")).text();
    const root = css.match(/\.k2b-ui\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(root).toContain("--k2b-focus-width: 2px;");
    // Only the outermost root places rings, so a nested root keeps an inset placement it inherits.
    expect(css.match(/--k2b-focus-offset: 2px;/g)).toHaveLength(1);
    expect(rules.find((rule) => rule.body.includes("--k2b-focus-offset: 2px;"))?.selector).toBe(".k2b-ui:not(.k2b-ui *)");

    // The pane separator highlights its handle line with a glow; it is not a ring around a control.
    const handleGlow = ".k2b-ui .k2b-panes__separator:focus-visible > span";
    const untokenized: string[] = [];
    for (const rule of rules.filter(
      (candidate) => isFocusSelector(candidate.selector) && !(candidate.selector === handleGlow && !candidate.context),
    )) {
      const declarations = cssDeclarations(rule.body);
      const where = `${rule.file}: ${rule.context ? `${rule.context} ` : ""}${rule.selector}`;
      for (const outline of declarations.get("outline") ?? []) {
        if (hasVisibleValue([outline]) && !outline.includes("var(--k2b-focus-width)")) untokenized.push(`${where} outline: ${outline}`);
      }
      for (const offset of declarations.get("outline-offset") ?? []) {
        if (!/var\(--k2b-focus-(?:offset|width)\)/.test(offset)) untokenized.push(`${where} outline-offset: ${offset}`);
      }
      // A spread-only shadow is a ring. An outer one cannot move inside a clipping container, so rings are outlines or inset.
      for (const shadow of declarations.get("box-shadow") ?? []) {
        const ring = /^(?:inset\s+)?0(?:px)?\s+0(?:px)?\s+0(?:px)?\s+/.test(shadow);
        if (ring && !(shadow.startsWith("inset") && shadow.includes("var(--k2b-focus-width)")))
          untokenized.push(`${where} box-shadow: ${shadow}`);
      }
    }
    expect(untokenized).toEqual([]);
  });

  test("moves rings inside every clipping container, and filled controls draw theirs on the fill", async () => {
    const list = (selector: string, head: string) =>
      selector
        .slice(head.length, selector.lastIndexOf(")", selector.endsWith(":where(:focus-visible)") ? selector.length - 23 : undefined))
        .split(/,(?![^(]*\))/)
        .map((part) => part.trim());
    const scopes = new Map<string, string[]>();
    const inherited = new Map<string, string[]>();
    for (const rule of rules) {
      if (rule.selector.startsWith(".k2b-ui :is(") && rule.body.includes("--k2b-focus-offset: calc(-1 * var(--k2b-focus-width))")) {
        expect(rule.body, rule.selector).toContain("--k2b-focus-on-fill: currentColor");
        scopes.set(rule.file, list(rule.selector, ".k2b-ui :is("));
      }
      if (rule.selector.startsWith(".k2b-ui :where(") && rule.selector.endsWith(":where(:focus-visible)")) {
        expect(rule.body, rule.selector).toBe("outline-offset: var(--k2b-focus-offset);");
        inherited.set(rule.file, list(rule.selector, ".k2b-ui :where("));
      }
    }

    // Each stylesheet moves the rings inside the containers it owns, and controls
    // without their own ring follow exactly the same containers.
    expect([...inherited]).toEqual([...scopes]);
    const all = [...scopes.values()].flat();
    for (const container of [
      ".k2b-focus-inset",
      ".k2b-app-workspace",
      ".k2b-scroll-area",
      ".k2b-detail-panel",
      ".k2b-settings",
      ".k2b-dialog",
      ".k2b-table-shell",
      ".k2b-widget",
      ".k2b-stat-grid",
      ".k2b-pagination",
    ]) {
      expect(all, container).toContain(container);
    }

    const css = await Bun.file(resolve(stylesDir, "index.css")).text();
    expect(css).toMatch(
      /\[data-variant="primary"\][\s\S]*?\):focus-visible \{\s*outline-color: var\(--k2b-focus-on-fill, var\(--k2b-focus-ring\)\);/,
    );
  });

  test("renders at most one focus signal per focused selector", () => {
    const focused = rules.filter((rule) => isFocusSelector(rule.selector));
    const grouped = new Map<string, typeof focused>();
    for (const rule of focused) {
      const key = `${rule.context}||${rule.selector}`;
      grouped.set(key, [...(grouped.get(key) ?? []), rule]);
    }
    const signaled = [...grouped.values()].filter((group) => focusSignalCount(group.map((rule) => rule.body).join(";")) > 0);
    const divergent = signaled
      .filter((group) => focusSignalCount(group.map((rule) => rule.body).join(";")) > 1)
      .map((group) => group.map((rule) => `${rule.file}: ${rule.selector}`).join(" + "));

    expect(shippedStyleFiles(stylesDir)).toEqual([
      "index.css",
      "feedback-parity.css",
      "layout-parity.css",
      "surfaces-widgets-parity.css",
      "content-parity.css",
      "editors-parity.css",
    ]);
    expect(focused.length).toBeGreaterThan(0);
    expect(signaled.length).toBeGreaterThan(0);
    expect(divergent).toEqual([]);
  });

  test("backs every box-shadow-only focus signal with a selector-scoped forced-colors outline", () => {
    const shadowOnly = rules.filter((rule) => {
      if (!isFocusSelector(rule.selector) || rule.context.includes("@media (forced-colors: active)")) return false;
      const declarations = cssDeclarations(rule.body);
      const hasShadow = hasVisibleValue(declarations.get("box-shadow"));
      const hasOutline = hasVisibleValue(declarations.get("outline")) || hasVisibleValue(declarations.get("outline-color"));
      const hasBorder = hasVisibleValue(declarations.get("border-color"));
      return hasShadow && !hasOutline && !hasBorder;
    });

    const missing = shadowOnly
      .filter(
        (base) =>
          !rules.some((fallback) => {
            if (
              fallback.file !== base.file ||
              fallback.selector !== base.selector ||
              !fallback.context.includes("@media (forced-colors: active)")
            ) {
              return false;
            }
            const declarations = cssDeclarations(fallback.body);
            return hasVisibleValue(declarations.get("outline")) || hasVisibleValue(declarations.get("outline-color"));
          }),
      )
      .map((rule) => `${rule.file}: ${rule.selector}`);

    expect(shadowOnly.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  test("recognizes literal and token-based focus signals after stripping comments", () => {
    expect(focusSignalCount("border-color: var(--k2b-focus-ring); outline: 2px solid #6366f1")).toBe(2);
    expect(focusSignalCount("/* outline: 2px solid red */ border-color: var(--k2b-focus-ring)")).toBe(1);
    expect(isFocusSelector(".k2b-field[data-focused=true]")).toBe(true);
    expect(isFocusSelector(".k2b-field.is-focused")).toBe(true);
  });

  test("keeps shared fields aligned with Cloud's filled field contract", async () => {
    const css = await Bun.file(resolve(stylesDir, "index.css")).text();
    const shared = [
      ".k2b-ui .k2b-input-shell",
      ".k2b-ui .k2b-choice-trigger",
      ".k2b-ui .k2b-multi-select-trigger",
      ".k2b-ui .k2b-combobox__input",
      ".k2b-ui .k2b-tags-input",
      ".k2b-ui .k2b-date-trigger",
      ".k2b-ui .k2b-color-input__value",
    ];
    expect(css).toContain("--k2b-focus-inset: inset 0 0 0 var(--k2b-focus-width)");
    for (const selector of shared) {
      const body = rules
        .filter((rule) => rule.selector === selector)
        .map((rule) => rule.body)
        .join("\n");
      expect(body, selector).toMatch(/min-height:\s*2\.25rem/);
      expect(body, selector).toMatch(/border:\s*1px solid transparent/);
      expect(body, selector).toMatch(/background:\s*var\(--k2b-field-surface, var\(--k2b-surface-muted\)\)/);
    }
    expect(css).not.toContain(".k2b-select-shell");
    expect(css).toMatch(
      /\.k2b-ui \.k2b-input\s*\{[^}]*padding:\s*0\.375rem 0\.5rem;[^}]*font-size:\s*0\.875rem;[^}]*line-height:\s*1\.25rem;/s,
    );
  });

  test("keeps editable compound surfaces on one semantic cursor", () => {
    const cursorFor = (selector: string) =>
      rules
        .filter((rule) => rule.selector === selector)
        .map((rule) => rule.body)
        .join("\n");

    for (const selector of [
      ".k2b-ui .k2b-input-shell",
      ".k2b-ui .k2b-combobox__input",
      ".k2b-ui .k2b-tags-input",
      ".k2b-ui .k2b-prompt-search__input",
    ]) {
      expect(cursorFor(selector), selector).toMatch(/cursor:\s*text/);
    }

    expect(cursorFor(".k2b-ui .k2b-input-shell:has(.k2b-input:disabled)")).toMatch(/cursor:\s*not-allowed/);
    expect(cursorFor(".k2b-ui .k2b-input-shell__clear")).toMatch(/cursor:\s*pointer/);
    expect(cursorFor(".k2b-ui .k2b-input-shell__clear:disabled")).toMatch(/cursor:\s*not-allowed/);
    expect(cursorFor(".k2b-ui .k2b-button")).toMatch(/cursor:\s*pointer/);
    expect(cursorFor(".k2b-ui .k2b-button:disabled")).toMatch(/cursor:\s*not-allowed/);
  });

  test("keeps AI theme tokens inside AI and chat components", () => {
    // The AI palette may only be spent where a selector says it is an AI
    // surface: the `.k2b-ai-*` / `.k2b-chat-*` families, or a component class
    // whose own name opts in with an `-ai` suffix. Anything else would bleed
    // the AI accent into general chrome.
    const leaked = rules
      .filter((rule) => rule.body.includes("var(--k2b-ai-"))
      .filter((rule) => !/\.k2b-(?:ai|chat)-|\.k2b-[\w-]*-ai(?![\w-])|\.k2b-button\[data-variant=["']ai["']\]/.test(rule.selector))
      .map((rule) => `${rule.file}: ${rule.selector}`);

    expect(leaked).toEqual([]);
  });

  test("removes native focus chrome from controls inside compound focus shells", () => {
    const controlledEditors = [
      ".k2b-ui .k2b-input",
      ".k2b-ui .k2b-autocomplete__input",
      ".k2b-ui .k2b-markdown-editor__input",
      ".k2b-ui .k2b-combobox__input > input",
      ".k2b-ui .k2b-tags-input > input",
      ".k2b-ui .k2b-chat-composer__input textarea",
    ];

    for (const selector of controlledEditors) {
      const editableCss = rules
        .filter((rule) =>
          rule.selector
            .split(",")
            .map((part) => part.trim())
            .includes(selector),
        )
        .map((rule) => rule.body)
        .join("\n");
      expect(editableCss, selector).toMatch(/border:\s*0(?:\s*!important)?/);
      expect(editableCss, selector).toMatch(/outline:\s*(?:0|none)(?:\s*!important)?/);
    }
  });

  test("keeps browser autofill inside the TextInput visual shell", () => {
    const shell = rules.find((rule) => rule.selector === ".k2b-ui .k2b-text-input:has(> .k2b-input:autofill)");
    const input = rules.find((rule) => rule.selector === ".k2b-ui .k2b-text-input > .k2b-input:autofill");
    const focus = rules.find((rule) => rule.selector === ".k2b-ui .k2b-input-shell:focus-within");

    expect(shell?.body).toContain("background: var(--k2b-info-surface)");
    expect(input?.body).toContain("box-shadow: inset 0 0 0 1000px var(--k2b-info-surface)");
    expect(input?.body).toContain("-webkit-text-fill-color: var(--k2b-text)");
    expect(focus?.body).toContain("background: var(--k2b-surface)");
  });

  test("draws the TextInput focus ring above the autofill fill", () => {
    const ring = rules.find((rule) => rule.selector === ".k2b-ui .k2b-text-input:has(> .k2b-input:autofill):focus-within::after");
    const invalid = rules.find(
      (rule) => rule.selector === '.k2b-ui .k2b-text-input[data-invalid="true"]:has(> .k2b-input:autofill):focus-within::after',
    );
    const anchor = rules.find(
      (rule) => rule.selector === ".k2b-ui .k2b-text-input:has(> .k2b-input:autofill)" && rule.body.includes("position"),
    );

    expect(anchor?.body).toContain("position: relative");
    expect(ring?.body).toContain("position: absolute");
    expect(ring?.body).toContain("inset: 0");
    expect(ring?.body).toContain("box-shadow: var(--k2b-focus-inset)");
    expect(ring?.body).toContain("pointer-events: none");
    expect(invalid?.body).toContain("box-shadow: inset 0 0 0 var(--k2b-focus-width) var(--k2b-danger-500)");
  });

  test("keeps the tags editor geometry stable while its markup changes on focus", () => {
    const selector = ".k2b-ui .k2b-tags-input > input";
    const editableCss = rules
      .filter((rule) =>
        rule.selector
          .split(",")
          .map((part) => part.trim())
          .includes(selector),
      )
      .map((rule) => rule.body)
      .join("\n");

    expect(editableCss).toMatch(/box-sizing:\s*border-box/);
    expect(editableCss).toMatch(/height:\s*2rem/);
    expect(editableCss).toMatch(/overflow:\s*hidden/);
    expect(editableCss).toMatch(/white-space:\s*nowrap/);
  });

  test("lets autocomplete popovers apply their measured viewport position", () => {
    const selector = ".k2b-ui .k2b-autocomplete__options";
    const popoverCss = rules
      .filter((rule) =>
        rule.selector
          .split(",")
          .map((part) => part.trim())
          .includes(selector),
      )
      .map((rule) => rule.body)
      .join("\n");

    expect(popoverCss).toMatch(/position:\s*fixed/);
    expect(popoverCss).toMatch(/inset:\s*unset/);
    expect(popoverCss).not.toMatch(/inset:\s*(?:auto|unset)\s*!important/);
  });

  test("uses a surface change instead of a decorative active-pane underline", async () => {
    const css = await Bun.file(resolve(stylesDir, "index.css")).text();

    expect(css).not.toContain(".k2b-ui .k2b-panes__tab::after");
    expect(css).not.toContain('.k2b-ui .k2b-panes__tab[data-active="true"]::after');
  });

  test("does not fade interactive calendar days below the muted text contrast", () => {
    const selector = '.k2b-ui .k2b-date-grid button[data-outside="true"]';
    const outsideDayCss = rules
      .filter((rule) => rule.selector === selector)
      .map((rule) => rule.body)
      .join("\n");

    expect(outsideDayCss).toMatch(/color:\s*var\(--k2b-text-muted\)/);
    expect(outsideDayCss).not.toMatch(/opacity:/);
  });
});
