import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-autocomplete-select-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { AutocompleteSelect } = await import("./AutocompleteSelect");

test("renders a controlled editable selection with one labelled combobox", () => {
  const html = renderToString(() =>
    createComponent(AutocompleteSelect, {
      label: "Category",
      description: "Type an ID or label",
      value: "551",
      selectedOption: { value: "551", label: "Paintings", description: "Art > Paintings" },
      formatValue: (option) => `${option.value} — ${option.label}`,
      name: "category",
      required: true,
      clearable: true,
      search: async () => ({ options: [] }),
    }),
  );

  expect(html).toContain('role="combobox"');
  expect(html).toContain('aria-autocomplete="both"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('value="551 — Paintings"');
  expect(html).toContain('type="hidden" name="category" value="551"');
  expect(html).toContain('role="listbox"');
  expect(html).toContain('popover="manual"');
  expect(html).toContain('aria-label="Clear selection"');
  expect(html).toContain('class="k2b-choice-control__clear k2b-input-clear-action"');
  expect(html).toContain("ti ti-chevron-down");
  expect(html).toContain('role="status" aria-live="polite"');
});

test("renders fallback metadata without invoking the async matcher during SSR", () => {
  let calls = 0;
  const html = renderToString(() =>
    createComponent(AutocompleteSelect, {
      "aria-label": "Category",
      value: "551",
      search: async () => {
        calls += 1;
        return { options: [] };
      },
    }),
  );

  expect(calls).toBe(0);
  expect(html).toContain('value="551"');
  expect(html).toContain('aria-label="Category"');
});

test("renders the shared group filters around the suggestion listbox", () => {
  const html = renderToString(() =>
    createComponent(AutocompleteSelect, {
      label: "Category",
      value: null,
      groups: [
        { value: "recommended", label: "Recommended" },
        { value: "food", label: "Food" },
      ],
      defaultGroup: "recommended",
      search: async () => ({ options: [] }),
    }),
  );

  expect(html).toContain('role="radiogroup"');
  expect(html).toContain('aria-label="Filter options"');
  expect(html).toContain('role="radio" aria-checked="true"');
  expect(html).toContain(">Recommended</button>");
  expect(html).toContain('class="k2b-choice-options" role="listbox"');
});
