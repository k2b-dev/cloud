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
  "internal/dialog-history.ts": 3_800, // the history entry of `Dialog.confirm`, shared with the dialogs of v1 (3,042)
  "surfaces/notice-card-classes.ts": 370, // the notice classes of Markdown's info blocks
  "surfaces/person-color.ts": 270, // personColor for `Avatar`
};

test("an island of v2 alone (every export, and useLocale) bundles no v1 module", async () => {
  const directory = await mkdtemp(join(tmpdir(), "k2-v2-only-"));
  const entry = join(directory, "island.ts");
  try {
    await Bun.write(entry, `import * as v2 from ${JSON.stringify(join(import.meta.dir, "index.ts"))};\nconsole.log(v2, v2.useLocale);\n`);
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
    const outside: Record<string, number> = {};
    for (const name of closure)
      for (const [path, input] of Object.entries(outputs.get(name)?.inputs ?? {})) {
        const module = relative(src, resolve(path));
        if (input.bytesInOutput === 0 || module.startsWith("..") || module.startsWith("v2/") || module.startsWith("intl/")) continue;
        outside[module] = (outside[module] ?? 0) + input.bytesInOutput;
      }
    console.info("v2 island: modules outside v2 and intl", outside);
    expect(Object.keys(outside).sort()).toEqual(Object.keys(allowed).sort());
    for (const [module, bytes] of Object.entries(outside)) expect(bytes, module).toBeLessThanOrEqual(allowed[module] ?? 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
