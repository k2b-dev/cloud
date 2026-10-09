import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BunPlugin, OnLoadResult, PluginBuilder } from "bun";
import { compile } from "tailwindcss";
import { wrapTailwindPlugin } from "./tailwind";

const compoundDeclarations = [
  "background: color-mix(in oklab, var(--a) 12%, var(--b));",
  "border: 1px solid color-mix(in oklab, var(--a) 40%, var(--b));",
  "box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--a) 30%, var(--b));",
  "outline: 2px solid color-mix(in oklab, var(--a) 50%, var(--b));",
  "background-image: linear-gradient(color-mix(in oklab, var(--a) 20%, var(--b)), color-mix(in oklab, var(--b) 60%, var(--a)));",
  "--färbe: color-mix(in oklab, var(--a) 70%, var(--b));",
];

const fixture = `
@theme { --color-action: #0080ff; --color-surface: white; }
.highlight {
  background: color-mix(in oklab, var(--color-action) 12%, var(--color-surface));
  border-color: color-mix(in oklab, var(--color-action) 40%, var(--color-surface)) !important;
  --highlight: color-mix(in oklab, currentColor 20%, var(--color-surface));
  &:hover {
    color: color-mix(in oklab, var(--color-action) 60%, var(--color-surface));
    outline-color: color-mix(in oklab, currentColor 30%, var(--color-surface));
  }
}
.compound {
  ${compoundDeclarations.join("\n  ")}
}
`;

const normalize = (css: string) => css.replace(/\s+/g, " ").trim();
const supports = /@supports\s*\(\s*color:\s*color-mix\(/;

const cssPlugin = (contents: string): BunPlugin => ({
  name: "polyfilled-tailwind-fixture",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, () => ({ loader: "css", contents }));
  },
});

describe("Cloud Tailwind build wrapper", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cloud-tailwind-wrapper-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const buildCss = async (plugin: BunPlugin, source = "") => {
    const entrypoint = resolve(directory, "app.css");
    await Bun.write(entrypoint, source);
    const build = await Bun.build({ entrypoints: [entrypoint], outdir: resolve(directory, "dist"), plugins: [plugin] });
    if (!build.success) throw new AggregateError(build.logs, "Could not compile the fixture stylesheet.");
    return build.outputs[0]!.text();
  };

  // Observe onLoad before Bun parses CSS, including byte-identical passthrough.
  const observe = (plugin: BunPlugin, results: OnLoadResult[]): BunPlugin => ({
    name: "observe-tailwind-output",
    setup(build) {
      const onLoad: PluginBuilder["onLoad"] = (constraints, callback) => {
        build.onLoad(constraints, async (args) => {
          const result = await callback(args);
          results.push(result);
          return result;
        });
        return build;
      };
      return plugin.setup(
        new Proxy(build, {
          get(target, property, receiver) {
            return property === "onLoad" ? onLoad : Reflect.get(target, property, receiver);
          },
        }),
      );
    },
  });

  test("preserve leading and compound mixes from Tailwind 4.3.3 flat polyfills", async () => {
    const polyfilled = (await compile(fixture)).build([]);
    expect(polyfilled.match(new RegExp(supports.source, "g"))).toHaveLength(11);
    const css = normalize(await buildCss(wrapTailwindPlugin(cssPlugin(polyfilled))));
    for (const declaration of [
      "background: color-mix(in oklab, var(--color-action) 12%, var(--color-surface));",
      "border-color: color-mix(in oklab, var(--color-action) 40%, var(--color-surface)) !important;",
      "--highlight: color-mix(in oklab, currentColor 20%, var(--color-surface));",
      "color: color-mix(in oklab, var(--color-action) 60%, var(--color-surface));",
      "outline-color: color-mix(in oklab, currentColor 30%, var(--color-surface));",
      ...compoundDeclarations,
    ])
      expect(css).toContain(declaration);
    expect(css).not.toMatch(supports);
  });

  test("preserve leading and compound mixes from Tailwind 4.1.14 nested polyfills", async () => {
    const source = `.compound {
  background: var(--a);
  @supports (color: color-mix(in lab, red, red)) {
    & {
      background: color-mix(in oklab, var(--a) 12%, var(--b));
    }
  }
  border: 1px solid var(--a);
  @supports (color: color-mix(in lab, red, red)) {
    & {
      border: 1px solid color-mix(in oklab, var(--a) 40%, var(--b));
    }
  }
  box-shadow: inset 0 0 0 1px var(--a);
  @supports (color: color-mix(in lab, red, red)) {
    & {
      box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--a) 30%, var(--b));
    }
  }
  outline: 2px solid var(--a);
  @supports (color: color-mix(in lab, red, red)) {
    & {
      outline: 2px solid color-mix(in oklab, var(--a) 50%, var(--b));
    }
  }
  background-image: linear-gradient(var(--a), var(--b));
  @supports (color: color-mix(in lab, red, red)) {
    & {
      background-image: linear-gradient(color-mix(in oklab, var(--a) 20%, var(--b)), color-mix(in oklab, var(--b) 60%, var(--a)));
    }
  }
  --färbe: var(--a);
  @supports (color: color-mix(in lab, red, red)) {
    & {
      --färbe: color-mix(in oklab, var(--a) 70%, var(--b));
    }
  }
}`;
    const css = normalize(await buildCss(wrapTailwindPlugin(cssPlugin(source))));
    for (const declaration of compoundDeclarations) expect(css).toContain(declaration);
    expect(css).not.toMatch(supports);
  });

  test("remove the polyfill with a nested parent selector", async () => {
    const source = `.x {
  color: var(--a) !important;
  @supports (color: color-mix(in lab, red, red)) {
    & {
      color: color-mix(in oklab, var(--a) 50%, var(--b)) !important;
    }
  }
}`;
    const results: OnLoadResult[] = [];
    await buildCss(observe(wrapTailwindPlugin(cssPlugin(source)), results));
    expect(results).toEqual([
      {
        loader: "css",
        contents: `.x {
  color: color-mix(in oklab, var(--a) 50%, var(--b)) !important;
}`,
      },
    ]);
  });

  test.each([
    ["flat", " !important", ""],
    ["flat", "", " !important"],
    ["nested", " !important", ""],
    ["nested", "", " !important"],
  ])("preserve %s CSS with mismatched importance (%s / %s) byte-identically", async (shape, fallback, inner) => {
    const declaration = `color: color-mix(in srgb, red 50%, blue)${inner};`;
    const source = `.x {
  color: red${fallback};
  @supports (color: color-mix(in lab, red, red)) {
${shape === "nested" ? `    & {\n      ${declaration}\n    }` : `    ${declaration}`}
  }
}`;
    const results: OnLoadResult[] = [];
    await buildCss(observe(wrapTailwindPlugin(cssPlugin(source)), results));
    expect(results).toEqual([{ loader: "css", contents: source }]);
  });

  test("pass unpolyfilled CSS and unrelated supports rules through byte-identically", async () => {
    const source =
      (await compile(fixture, { polyfills: 1 })).build([]) +
      `
@supports (display: grid) { .x { display: grid; } }
.other {
  color: red;
  @supports (color: color-mix(in lab, red, red)) {
    background: color-mix(in oklab, var(--a) 50%, var(--b));
  }
}
`;
    const results: OnLoadResult[] = [];
    await buildCss(observe(wrapTailwindPlugin(cssPlugin(source)), results));
    expect(results).toEqual([{ loader: "css", contents: source }]);
  });

  test("forward build properties, hooks, setup results, and declined loads", async () => {
    const results: OnLoadResult[] = [];
    const plugin: BunPlugin = {
      name: "declined-load",
      setup(build) {
        build.config.define = { ...build.config.define, WRAPPER_TEST: "true" };
        build.onStart(() => {
          results.push(undefined);
        });
        build.onLoad({ filter: /\.css$/ }, () => undefined);
        return Promise.resolve();
      },
    };
    await buildCss(observe(wrapTailwindPlugin(plugin), results), ".x { color: red; }");
    expect(results).toEqual([undefined, undefined]);
  });
});
