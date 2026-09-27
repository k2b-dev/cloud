import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";

const workspaceRoot = resolve(import.meta.dir, "../../../..");

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/** Innermost `selector { declarations }` blocks, with comments removed. */
const ruleBlocks = (css: string) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: normalize(selector!),
    declarations: [...body!.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)].map(([, property, value]) => ({
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
      expect.arrayContaining([".dark --ui-selected", ".dark --ui-app-accent-border", ":root --ui-app-accent-text"]),
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

  // Pins the bun-plugin-tailwind patch, which every stylesheet build shares
  // (global.css, @k2b/ui, app.css, docs), so component rules outside tokens.css
  // are covered too. Remove this test together with the patch.
  test("compile without Tailwind's color-mix() polyfill", async () => {
    expect(await compileGlobal()).not.toMatch(/@supports\s*\(\s*color:\s*color-mix\(/);
  });
});
