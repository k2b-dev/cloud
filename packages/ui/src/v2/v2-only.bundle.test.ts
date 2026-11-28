// Guard: an island built only from `@k2b/ui/v2` carries no v1 code. Beside v2 itself it may load the shared intl
// modules and the listed helpers, which v2 takes from modules that also hold v1 components (only the helper is
// bundled). A new import from a v1 module fails here; take the helper into a shared module instead.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { transform } from "../../../ssr/src/transform";

const src = resolve(import.meta.dir, "..");
/**
 * Modules outside v2 and intl that a v2 island may load, with the most bytes each may bring: helpers and constants
 * from modules that also hold v1 components, never the components (their bytes would far exceed these).
 */
// Measured 26.11.2026 (Bun 1.4, minified), plus a quarter for the helpers growing.
const allowed: Record<string, number> = {
  "content/MarkdownView.tsx": 2_500, // renderSafeMarkdown for `Prose`
  "content/markdown-info-block-messages.ts": 550,
  "content/markdown-info-blocks.ts": 7_200,
  "content/markdown-links.ts": 3_600,
  "content/markdown-reference-messages.ts": 700,
  "inputs/date-input.ts": 6_600, // formatDateInput, parseDateInput
  "inputs/date-picker.ts": 450, // dateKey, isCalendarDay, isDateKey
  "surfaces/notice-card-classes.ts": 370, // the notice classes of Markdown's info blocks
  "surfaces/person-color.ts": 270, // personColor for `Avatar`
};

const v2Index = JSON.stringify(join(import.meta.dir, "index.ts"));

/**
 * The modules of `packages/ui/src` an island of `source` loads on its first render (the entry chunk and what it imports
 * statically), with the bytes each brings, minified; the behaviour layer and the libraries stay outside.
 */
const islandModules = async (source: string): Promise<Record<string, number>> => {
  const directory = await mkdtemp(join(tmpdir(), "k2-v2-only-"));
  const entry = join(directory, "island.ts");
  try {
    await Bun.write(entry, source);
    const result = await Bun.build({
      entrypoints: [entry],
      outdir: join(directory, "out"),
      target: "browser",
      conditions: ["browser", "production"],
      minify: true,
      splitting: true,
      metafile: true,
      external: ["@ui-sdk/*", "@k2b/stdlib", "@k2b/stdlib/*", "@k2b/ssr", "@k2b/ssr/*", "marked", "dompurify"],
      plugins: [
        {
          name: "v2-only-solid",
          setup(build) {
            build.onResolve({ filter: /^solid-js(?:\/(?:web|store))?$/ }, (args) => {
              const module = args.path === "solid-js" ? "solid" : args.path.slice("solid-js/".length);
              return { path: Bun.resolveSync(`${args.path}/dist/${module}.js`, import.meta.dir) };
            });
            build.onLoad({ filter: /\.(tsx|jsx)$/ }, async ({ path }) => ({
              contents: await transform(await Bun.file(path).text(), path, "dom"),
              loader: "js",
            }));
          },
        },
      ],
    });
    if (!result.success || !result.metafile) throw new AggregateError(result.logs, "v2-only build failed");
    const outputs = new Map(Object.entries(result.metafile.outputs).map(([path, output]) => [basename(path), output]));
    const first = [...outputs].find(([, output]) => output.entryPoint && resolve(output.entryPoint) === entry);
    if (!first) throw new Error("entry missing");
    const closure = new Set([first[0]]);
    for (const name of closure)
      for (const edge of outputs.get(name)?.imports ?? []) if (edge.kind === "import-statement") closure.add(basename(edge.path));
    const modules: Record<string, number> = {};
    for (const name of closure)
      for (const [path, input] of Object.entries(outputs.get(name)?.inputs ?? {})) {
        const module = relative(src, resolve(path));
        if (input.bytesInOutput === 0 || module.startsWith("..")) continue;
        modules[module] = (modules[module] ?? 0) + input.bytesInOutput;
      }
    return modules;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("an island of v2 alone (every export, and useLocale) bundles no v1 module", async () => {
  const modules = await islandModules(`import * as v2 from ${v2Index};\nconsole.log(v2, v2.useLocale);\n`);
  const outside = Object.fromEntries(
    Object.entries(modules).filter(([module]) => !module.startsWith("v2/") && !module.startsWith("intl/")),
  );
  console.info("v2 island: modules outside v2 and intl", outside);
  expect(Object.keys(outside).sort()).toEqual(Object.keys(allowed).sort());
  for (const [module, bytes] of Object.entries(outside)) expect(bytes, module).toBeLessThanOrEqual(allowed[module] ?? 0);
}, 60_000);

// Guard: a page pays only for the parts it draws. A `Nav` without a tree and a `Menu` without a panel load neither:
// the tree comes with `navTree`, the panel with `menuPanel` (#4187 and #4157 had added 41 KB and 7.5 KB to every
// island with a `Nav` or a `Menu`, Chat's first chunk over its budget). The tree's and the panel's behaviour lives in
// the behaviour layer, outside this measure; their modules here pull it in, so their absence is the guard.
const lean = `import { Menu, Nav, Workspace } from ${v2Index};\nconsole.log(Menu, Nav, Workspace);\n`;
// Measured 27.11.2026 (Bun 1.4.4, minified): 64 453 bytes of this package's own code, plus a tenth for growing. It holds
// `Input` (5.5 KB) for the nav's search (#4443), which nearly every page loads anyway; a tree or a panel never.
const leanBudget = Math.ceil(64_453 * 1.1);

test("an island with a Workspace, a Nav and a Menu loads no tree and no menu panel, and stays under its measure", async () => {
  const modules = await islandModules(lean);
  const total = Object.values(modules).reduce((sum, bytes) => sum + bytes, 0);
  console.info(`Workspace, Nav and Menu: ${total} bytes of packages/ui/src (budget ${leanBudget})`);
  expect(Object.keys(modules).filter((module) => ["v2/nav-tree.tsx", "v2/menu-panel.tsx", "v2/head-search.tsx"].includes(module))).toEqual(
    [],
  );
  expect(total).toBeLessThanOrEqual(leanBudget);
}, 60_000);

// A head's search (`HeadSearch`: its symbol, its overlay, "/", its words and its held menu) comes with the part that
// places it, as the tree and the panel do: an island whose head has no search loads none of it.
test("HeadSearch brings the head search along", async () => {
  const modules = await islandModules(
    `import { HeadSearch, Menu, Nav, Workspace } from ${v2Index};\nconsole.log(HeadSearch, Menu, Nav, Workspace);\n`,
  );
  expect(modules["v2/head-search.tsx"]).toBeGreaterThan(0);
}, 60_000);

test("navTree and menuPanel bring the tree and the panel along", async () => {
  const modules = await islandModules(
    `import { menuPanel, Menu, Nav, navTree, Workspace } from ${v2Index};\nconsole.log(Menu, Nav, Workspace, navTree, menuPanel);\n`,
  );
  expect(modules["v2/nav-tree.tsx"]).toBeGreaterThan(0);
  expect(modules["v2/menu-panel.tsx"]).toBeGreaterThan(0);
}, 60_000);
