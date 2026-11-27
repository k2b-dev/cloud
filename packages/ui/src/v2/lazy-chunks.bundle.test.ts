// Guard: a v2 part that only a lazy chunk of a page uses stays in that chunk. Bun splits by module. A module that the
// first chunk loads carries every statement any chunk uses, and so does each module that code reaches. A part that
// shares its module with a part of nearly every page (`Select` beside `Input`) therefore drags its behaviour into the
// first chunk of every page: Chat measured +47 KB for one `Select` on a lazy page (26.11.2026). So each part with
// behaviour of its own has a module of its own. The barrel `index.ts` does not leak: Bun follows a re-export only to a
// part that is used.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { transform } from "../../../ssr/src/transform";
import * as v2 from "./index";

const src = resolve(import.meta.dir, "..");
const index = JSON.stringify(join(import.meta.dir, "index.ts"));
/** The parts nearly every page draws in its first chunk: a workspace with panes, lists, a form line and a menu. */
const firstChunk = [
  "Avatar",
  "Bar",
  "Button",
  "Cells",
  "Check",
  "Chip",
  "Dialog",
  "Empty",
  "Failed",
  "Field",
  "Icon",
  "Inline",
  "Input",
  "List",
  "Loading",
  "Menu",
  "Nav",
  "Notice",
  "Pane",
  "Popover",
  "Row",
  "Section",
  "StatusRow",
  "Table",
  "Tabs",
  "Text",
  "Workspace",
  "useToast",
] as const;
/** Everything else a page may load later, each in a chunk of its own. */
const later = Object.keys(v2)
  .filter((name) => !(firstChunk as readonly string[]).includes(name))
  .sort();

/** The modules of the first chunk and the chunks it imports statically, with the bytes each brings. */
const firstModules = async (lazy: readonly string[]): Promise<Map<string, number>> => {
  const directory = await mkdtemp(join(tmpdir(), "k2-v2-lazy-"));
  const entry = join(directory, "page.ts");
  try {
    const names = firstChunk.join(", ");
    const loads = lazy.map((name) => `() => import("./later-${name}.ts")`).join(",\n  ");
    await Bun.write(entry, `import { ${names} } from ${index};\nconsole.log(${names});\nexport const later = [\n  ${loads}\n];\n`);
    for (const name of lazy)
      await Bun.write(join(directory, `later-${name}.ts`), `import { ${name} } from ${index};\nconsole.log(${name});\n`);
    const result = await Bun.build({
      entrypoints: [entry],
      outdir: join(directory, "out"),
      target: "browser",
      conditions: ["browser", "production"],
      minify: true,
      splitting: true,
      metafile: true,
      external: ["@k2b/stdlib", "@k2b/stdlib/*", "@k2b/ssr", "@k2b/ssr/*", "marked", "dompurify"],
      plugins: [
        {
          name: "v2-lazy-solid",
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
    if (!result.success || !result.metafile) throw new AggregateError(result.logs, "v2 lazy-chunk build failed");
    const outputs = new Map(Object.entries(result.metafile.outputs).map(([path, output]) => [basename(path), output]));
    const first = [...outputs].find(([, output]) => output.entryPoint && resolve(output.entryPoint) === entry);
    if (!first) throw new Error("page entry missing");
    const closure = new Set([first[0]]);
    for (const name of closure)
      for (const edge of outputs.get(name)?.imports ?? []) if (edge.kind === "import-statement") closure.add(basename(edge.path));
    const modules = new Map<string, number>();
    for (const name of closure)
      for (const [path, input] of Object.entries(outputs.get(name)?.inputs ?? {}))
        if (input.bytesInOutput > 0 && resolve(path) !== entry) {
          // packages from the store by name and path, so a version change keeps the comparison
          const module = relative(src, resolve(path)).replace(/^.*\/node_modules\/\.bun\/[^/]+\/node_modules\//, "");
          modules.set(module, (modules.get(module) ?? 0) + input.bytesInOutput);
        }
    return modules;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

/**
 * Modules of the ui-sdk core a lazy form control may bring, with the most bytes each: a core module the first chunk
 * loads anyway (the menu, dialog and tree behaviour) reaches them in the statements a form control uses, and our split
 * cannot divide a module of the core. Measured 27.11.2026 (Bun 1.4, minified), plus a quarter.
 */
const allowed: Record<string, number> = {
  "@ui-sdk/core/dist/foundation/forms/value.js": 590,
  "@ui-sdk/core/dist/foundation/kernel/early-text.js": 85,
};

test("a v2 part that only a lazy chunk uses brings no module into the first chunk", async () => {
  const [alone, withLater] = await Promise.all([firstModules([]), firstModules(later)]);
  // Bytes of a module the first chunk loads anyway grow a little once a page splits (names cross chunks); only a
  // module it did not need counts.
  const brought = Object.fromEntries([...withLater].filter(([module]) => !alone.has(module)));
  console.info(`v2 first chunk: ${alone.size} modules alone, modules the later parts bring`, brought);
  const unexpected = Object.fromEntries(Object.entries(brought).filter(([module, bytes]) => bytes > (allowed[module] ?? 0)));
  expect(unexpected).toEqual({});
}, 60_000);
