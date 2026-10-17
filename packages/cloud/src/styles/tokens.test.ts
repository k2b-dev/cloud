import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";

const workspaceRoot = resolve(import.meta.dir, "../../../..");

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/** Innermost `selector { declarations }` blocks, with comments removed. */
const ruleBlocks = (css: string) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: normalize(selector!),
    declarations: [...body!.matchAll(/(?:^|;)\s*(--[\w-]+|color)\s*:\s*([^;]+)/g)].map(([, property, value]) => ({
      property: property!,
      value: normalize(value!),
    })),
  }));

let compiledGlobal: Promise<string> | undefined;
const compileGlobal = () =>
  (compiledGlobal ??= Bun.build({ entrypoints: [resolve(workspaceRoot, "styles.css")], plugins: [tailwind] }).then((build) => {
    if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
    return build.outputs[0]!.text();
  }));

describe("Cloud tokens", () => {
  test("pins light and dark ink and uses secondary ink for compiled text utilities", async () => {
    const source = ruleBlocks(await Bun.file(resolve(import.meta.dir, "tokens.css")).text());
    for (const { selector, secondary, dimmed } of [
      { selector: ":root", secondary: "#27272a", dimmed: "#55555e" },
      { selector: ".dark", secondary: "#f1f1f3", dimmed: "#a8a8b2" },
    ]) {
      const declarations = source.filter((rule) => rule.selector === selector).flatMap((rule) => rule.declarations);
      expect({
        selector,
        ink: declarations.filter(({ property }) => ["--ui-text-secondary", "--ui-text-dimmed"].includes(property)),
      }).toEqual({
        selector,
        ink: [
          { property: "--ui-text-secondary", value: secondary },
          { property: "--ui-text-dimmed", value: dimmed },
        ],
      });
    }

    const compiled = ruleBlocks(await compileGlobal());
    for (const selector of [".text-secondary", ".text-label"]) {
      const colors = compiled
        .filter((rule) => rule.selector.split(",").map(normalize).includes(selector))
        .flatMap((rule) => rule.declarations.filter(({ property }) => property === "color"));
      expect({ selector, colors }).toEqual({ selector, colors: [{ property: "color", value: "var(--ui-text-secondary)" }] });
    }
  });

  test("has the motion tokens and stops view transitions under reduced motion", async () => {
    const css = (await compileGlobal()).replace(/\s+/g, "");
    const auto = /@media\(prefers-reduced-motion:no-preference\)\{@view-transition\{navigation:auto;?\}\}/g;
    expect(css.match(auto)).toHaveLength(1);
    expect(css.replace(auto, "")).not.toMatch(/@view-transition\{navigation:auto/);
    // The compiler writes one rule per pseudo-element.
    const instant = (host: string) =>
      ["group", "old", "new"].map((part) => `${host}::view-transition-${part}(*){animation:none!important;}`).join("");
    expect(css).toContain(`@media(prefers-reduced-motion:reduce){${instant("")}}`);
    expect(css).toContain(instant('html[data-k2b-motion="reduced"]'));
    for (const token of ["motion-fast", "motion-base", "motion-sheet", "motion-celebrate", "fresh-fade", "ease-out", "ease-spring"])
      expect(css).toContain(`--k2b-${token}:`);
  });

  // Bun 1.4.2 keeps only the first of adjacent same-condition @supports rules
  // (oven-sh/bun#24770). With Tailwind's color-mix() polyfill that left one
  // mixed value per rule; the others fell back to their first color.
  test("keep every color-mix() value in the compiled global stylesheet", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "tokens.css")).text();
    const mixed = ruleBlocks(source)
      .filter(({ selector }) => !selector.startsWith("@"))
      .flatMap(({ selector, declarations }) =>
        declarations.filter(({ value }) => value.includes("color-mix(")).map((declaration) => ({ selector, ...declaration })),
      );
    expect(mixed.map(({ selector, property }) => `${selector} ${property}`)).toEqual(
      expect.arrayContaining([".dark --ui-selected", ".dark --ui-app-accent-border", ":root --ui-selected"]),
    );

    const compiled = ruleBlocks(await compileGlobal());

    const lost = mixed.filter(
      ({ selector, property, value }) =>
        !compiled.some(
          (rule) =>
            rule.selector === selector &&
            rule.declarations.some((declaration) => declaration.property === property && declaration.value === value),
        ),
    );
    expect(lost).toEqual([]);
  });

  test("app scopes re-read inline app ink and selection fills in both compiled themes", async () => {
    const compiled = ruleBlocks(await compileGlobal());
    for (const theme of ["light", "dark"]) {
      const hasDark = theme === "dark";
      const mappings = [
        { property: "--ui-app-accent-text", value: `var(--app-ink-${theme})` },
        { property: "--ui-app-selected", value: `var(--app-selected-${theme})` },
        { property: "--ui-app-selected-nav", value: `var(--app-selected-nav-${theme})` },
      ];
      expect(
        compiled.some(
          ({ selector, declarations }) =>
            selector.includes(".cloud-app-canvas") &&
            selector.includes(".app-accent-scope") &&
            selector.includes(".dark") === hasDark &&
            mappings.every(({ property, value }) => declarations.some((item) => item.property === property && item.value === value)),
        ),
        `${theme} app scope mappings`,
      ).toBe(true);
      expect(
        compiled.some(
          ({ selector, declarations }) =>
            selector === (hasDark ? ".dark" : ":root") &&
            mappings.every(({ property, value }) => declarations.some((item) => item.property === property && item.value === value)),
        ),
        `${theme} platform mappings`,
      ).toBe(true);
    }
  });

  // Pins the bun-plugin-tailwind patch, which every stylesheet build shares
  // (global.css, @k2b/ui, app.css, docs), so component rules outside tokens.css
  // are covered too. Remove this test together with the patch.
  test("compile without Tailwind's color-mix() polyfill", async () => {
    expect(await compileGlobal()).not.toMatch(/@supports\s*\(\s*color:\s*color-mix\(/);
  });
});
