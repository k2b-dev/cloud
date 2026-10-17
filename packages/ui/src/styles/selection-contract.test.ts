import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { cssDeclarations, parseCssRules } from "./css-contract-test-helpers";

// Include nested imports such as file-grid.css as well as entry.css's imports.
const rules = readdirSync(import.meta.dir)
  .filter((file) => file.endsWith(".css"))
  .flatMap((file) => parseCssRules(file, readFileSync(resolve(import.meta.dir, file), "utf8")));
const declarations = (selector: string) => {
  const matches = rules.filter((rule) => rule.selector === selector && !rule.context);
  expect(matches.length, selector).toBeGreaterThan(0);
  return cssDeclarations(matches.map((rule) => rule.body).join(";"));
};
const sidebar = ".k2b-ui .k2b-app-workspace__sidebar-item";
const icon = ".k2b-ui .k2b-app-workspace__sidebar-icon-action";
const navFill = [
  `${sidebar}.is-active`,
  `${sidebar}.is-active:hover`,
  `${sidebar}[data-variant="card"].is-active`,
  `${icon}.is-active`,
  `${icon}.is-active:hover`,
  ".k2b-ui .k2b-navigation__row[data-active] > .k2b-navigation__control",
  '.k2b-ui .k2b-settings__tabs button[data-active="true"]',
];
const navInk = [
  `${sidebar}.is-active`,
  `${sidebar}[data-variant="object"].is-active:not(.has-action)`,
  `${sidebar}[data-variant="object"].is-active .k2b-app-workspace__sidebar-item-main`,
  `${icon}.is-active`,
  `${icon}.is-active:hover`,
  ".k2b-ui .k2b-navigation__row[data-active] > .k2b-navigation__control",
  '.k2b-ui .k2b-settings__tabs button[data-active="true"]',
];
const rows = [
  '.k2b-ui .k2b-data-table__row[data-selected="true"]',
  '.k2b-ui .k2b-file-grid__item[aria-selected="true"]',
  '.k2b-ui .k2b-content-file-tree__row[data-state="selected"]',
];

describe("selection hooks", () => {
  test("standalone defaults alias platform selection and action without color-mix", () => {
    const scope = declarations(".k2b-ui");
    for (const hook of ["--k2b-nav-selected", "--k2b-row-selected"]) {
      expect(scope.get(hook), hook).toEqual(["var(--k2b-selected)"]);
      expect(scope.get(hook)!.join()).not.toContain("color-mix(");
    }
    expect(scope.get("--k2b-app-workspace-active")).toEqual(["var(--k2b-action)"]);
  });

  test("navigation uses the host fill and ink, including selected hover", () => {
    for (const selector of navFill) expect(declarations(selector).get("background"), selector).toEqual(["var(--k2b-nav-selected)"]);
    for (const selector of navInk) expect(declarations(selector).get("color"), selector).toEqual(["var(--k2b-app-workspace-active)"]);
    expect(declarations(`${sidebar}.is-active`).get("font-weight")).toEqual(["600"]);
  });

  test("content selection changes paint without weight, padding, or border width", () => {
    for (const selector of rows) {
      const selected = declarations(selector);
      expect(selected.get("background"), selector).toEqual(["var(--k2b-row-selected)"]);
      expect(
        [...selected.keys()].filter((property) => /^(?:font(?:-weight)?|padding(?:-.+)?|border(?:-.+)?-width|border)$/.test(property)),
        selector,
      ).toEqual([]);
      for (const rule of rules.filter((rule) => rule.selector === selector)) {
        // @apply must not sneak in weight or geometry changes.
        expect(rule.body, selector).not.toMatch(/@apply[^;]*(?:font-|p[trblxyse]?-|border(?:-\d|\s|;))/);
      }
    }
  });

  test("control options and pressed states retain platform selection", () => {
    // Select and Combobox render .k2b-choice-option; ChoiceGroups also has its own button rule.
    for (const selector of [
      '.k2b-ui .k2b-choice-option[aria-selected="true"]',
      '.k2b-ui .k2b-choice-groups > button[aria-checked="true"]',
      '.k2b-ui .k2b-autocomplete__option[aria-selected="true"]',
      '.k2b-ui .k2b-filter-chip[data-active="true"]',
      '.k2b-ui .k2b-panel-dialog__tabs .k2b-tabs__list button[aria-selected="true"]',
      ".k2b-ui .k2b-pagination__page.is-current",
      '.k2b-ui .k2b-date-durations button[aria-pressed="true"]',
      '.k2b-ui .k2b-toolbar .k2b-button[aria-pressed="true"]',
      '.k2b-ui .k2b-toolbar .k2b-button[aria-pressed="true"]:hover:not(:disabled)',
      '.k2b-ui .k2b-markdown-editor__tool[aria-pressed="true"]',
      '.k2b-ui .k2b-emoji-picker__tones > button[aria-checked="true"]',
      '.k2b-ui .k2b-emoji-picker__groups > button[aria-current="true"]',
      '.k2b-ui .k2b-range-picker__option[data-selected="true"]',
      ".k2b-ui .k2b-message-row[data-own] .k2b-message-row__bubble",
    ])
      expect(declarations(selector).get("background"), selector).toEqual(["var(--k2b-selected)"]);
  });

  test("other controls retain their existing platform surfaces and solid action fill", () => {
    for (const selector of [
      '.k2b-ui .k2b-segmented-control__option[data-selected="true"]',
      '.k2b-ui .k2b-segmented-control__option[aria-checked="true"]',
      '.k2b-ui .k2b-dropdown__row > .k2b-dropdown__item[data-selected="true"]',
    ])
      expect(declarations(selector).get("background"), selector).toEqual(["var(--k2b-surface)"]);
    for (const selector of ['.k2b-ui .k2b-date-grid button[aria-selected="true"]', '.k2b-ui .k2b-date-months button[data-selected="true"]'])
      expect(declarations(selector).get("background"), selector).toEqual(["var(--k2b-action-solid)"]);
    expect(declarations('.k2b-ui .k2b-tabs__list button[aria-selected="true"]').has("background")).toBe(false);
  });

  test("only the listed navigation and content rules consume selection hooks", () => {
    for (const [hook, allowed] of [
      ["--k2b-nav-selected", navFill],
      ["--k2b-row-selected", rows],
    ] as const) {
      const consumers = rules.filter((rule) => [...cssDeclarations(rule.body).values()].flat().some((value) => value.includes(hook)));
      expect(consumers.map((rule) => rule.selector).sort(), hook).toEqual([...allowed].sort());
    }
  });
});
