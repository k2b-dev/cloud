/**
 * Guards for the bundled icon catalogue behind `IconInput`.
 *
 * The catalogue is deliberately a reduced, application-neutral subset of the
 * Tabler webfont. Consumers can swap in their own list through `IconInput`'s
 * `options` prop. What must not drift is the entry shape, group coverage, or
 * the fact that every glyph actually exists in the webfont the package ships.
 *
 * Requires the built preset — `bun run build` (the package `test` script does
 * that first).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_ICON_GROUPS, DEFAULT_ICON_OPTIONS } from "./icon-options";

const tablerPath = resolve(import.meta.dir, "../../dist/tabler.css");
if (!existsSync(tablerPath)) throw new Error("dist/tabler.css is missing — run `bun run build` before this test");

/** Every `.ti-*` class the shipped webfont preset actually defines. */
const shippedGlyphs = new Set([...readFileSync(tablerPath, "utf8").matchAll(/\.ti-([a-z0-9-]+)/g)].map((match) => match[1] as string));

describe("@k2b/ui default icon catalogue", () => {
  test("only lists glyphs the shipped Tabler preset can render", () => {
    expect(shippedGlyphs.size).toBeGreaterThan(1000);

    const missing = DEFAULT_ICON_OPTIONS.filter((option) => !shippedGlyphs.has(option.value.replace("ti ti-", "")));
    expect(missing.map((option) => option.value)).toEqual([]);
  });

  test("keeps every entry in the shape IconInput and Select rely on", () => {
    for (const option of DEFAULT_ICON_OPTIONS) {
      const optionGroups = option.groups ?? [];
      // `value` is the stored class string, so consumers can render it with
      // `<i class={value} />` without prepending the family class themselves.
      expect(option.value).toMatch(/^ti ti-[a-z0-9-]+$/);
      // Select reads the dropdown glyph from `option.icon`.
      expect(option.icon).toBe(option.value);
      expect(String(option.label).length).toBeGreaterThan(0);
      expect(String(option.description).length).toBeGreaterThan(0);
      // The bare glyph name has to lead the keywords, otherwise typing the
      // Tabler name itself stops matching.
      expect(option.keywords?.[0]).toBe(option.value.replace("ti ti-", ""));
      expect(option.keywords?.length ?? 0).toBeGreaterThan(1);
      expect(optionGroups.length).toBeGreaterThan(0);
      expect(new Set(optionGroups).size).toBe(optionGroups.length);
    }
  });

  test("uses only declared groups and gives every group useful coverage", () => {
    const groups = new Set<string>(DEFAULT_ICON_GROUPS.map((group) => group.value));

    for (const option of DEFAULT_ICON_OPTIONS) {
      expect(option.groups?.filter((group) => !groups.has(group))).toEqual([]);
    }
    for (const group of groups) {
      expect(DEFAULT_ICON_OPTIONS.filter((option) => option.groups?.includes(group)).length).toBeGreaterThanOrEqual(5);
    }
  });

  test("has no duplicate values or labels", () => {
    const values = DEFAULT_ICON_OPTIONS.map((option) => option.value);
    const labels = DEFAULT_ICON_OPTIONS.map((option) => String(option.label));

    expect(new Set(values).size).toBe(values.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("is a frozen-in list of a useful size, sorted work is left to IconInput", () => {
    // A catalogue that silently shrinks to a handful of entries would make the
    // picker useless without failing any render test.
    expect(DEFAULT_ICON_OPTIONS.length).toBeGreaterThanOrEqual(120);
  });
});
