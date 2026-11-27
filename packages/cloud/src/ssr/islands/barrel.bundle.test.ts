// Guard (#4280): an island that takes `V2WorkspaceNavigation` from the `@k2b/cloud/ssr/islands` barrel weighs what
// the direct import weighs, also when other islands of the same build use the rest of the barrel (the help, the
// launchpad, the admin frame). Without `sideEffects` in packages/cloud/package.json a bundler keeps every module behind
// the barrel for its possible effects, and code splitting puts what the other islands use into the chunks this island
// loads: Mail's v2 island carried about 68 KB it never ran. The rule cloud-side-effects keeps that list exact.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { transform } from "../../../../ssr/src/transform";

const ssr = resolve(import.meta.dir, "..");
const entries = {
  barrel: `import { V2WorkspaceNavigation } from ${JSON.stringify(join(ssr, "islands/index.ts"))};\nconsole.log(V2WorkspaceNavigation);\n`,
  direct: `import V2WorkspaceNavigation from ${JSON.stringify(join(ssr, "V2WorkspaceNavigation.tsx"))};\nconsole.log(V2WorkspaceNavigation);\n`,
  // another island of the same build uses the rest of the barrel
  rest: `import { AdminWorkspace, Layout, PageTrail, SearchBar } from ${JSON.stringify(join(ssr, "islands/index.ts"))};\nconsole.log(AdminWorkspace, Layout, PageTrail, SearchBar);\n`,
};
// Measured 27.11.2026 (Bun 1.4, minified): the barrel's island 1,206 B above the direct import (its own re-exports and
// a name or two that crosses a chunk), down from 68,005 B; a small margin for that.
const MARGIN = 4 * 1024;

test("an island that takes V2WorkspaceNavigation from the islands barrel weighs about what the direct import weighs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-islands-barrel-"));
  try {
    const paths = Object.fromEntries(Object.keys(entries).map((name) => [name, join(directory, `${name}.ts`)]));
    for (const [name, code] of Object.entries(entries)) await Bun.write(paths[name]!, code);
    const result = await Bun.build({
      entrypoints: Object.values(paths),
      outdir: join(directory, "out"),
      target: "browser",
      conditions: ["browser", "production"],
      define: { "process.env.NODE_ENV": '"production"' },
      minify: true,
      splitting: true,
      metafile: true,
      plugins: [
        {
          name: "islands-barrel-solid",
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
    if (!result.success || !result.metafile) throw new AggregateError(result.logs, "islands barrel build failed");
    const outputs = new Map(Object.entries(result.metafile.outputs).map(([path, output]) => [basename(path), output]));
    /** The bytes an entry loads before it runs: its own chunk and every chunk it imports statically. */
    const weight = (entry: string): number => {
      const first = [...outputs].find(([, output]) => output.entryPoint && resolve(output.entryPoint) === entry);
      if (!first) throw new Error(`entry missing: ${entry}`);
      const closure = new Set([first[0]]);
      for (const name of closure)
        for (const edge of outputs.get(name)?.imports ?? []) if (edge.kind === "import-statement") closure.add(basename(edge.path));
      return [...closure].reduce((bytes, name) => bytes + (outputs.get(name)?.bytes ?? 0), 0);
    };
    const [barrel, direct] = [weight(paths.barrel!), weight(paths.direct!)];
    console.info(`V2WorkspaceNavigation: ${barrel} B from the islands barrel, ${direct} B imported directly`);
    expect(barrel - direct).toBeLessThanOrEqual(MARGIN);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
