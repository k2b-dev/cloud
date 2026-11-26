// Guard of the frame entry's weight: what a page with a server-rendered Workspace loads at once is the small core of
// `attachWorkspaces`; @ui-sdk/core (drawer, alert dialog, toaster) loads only on first use.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { transform } from "../../../ssr/src/transform";

// Measured 26.11.2026 with Bun 1.4: the static closure of the entry is 35 KB min (Solid 26 KB, the core, the UI
// messages); the budget keeps a margin for the messages growing, not room for a library.
const STATIC_BUDGET = 40 * 1024;

test("the frame entry loads @ui-sdk/core only on first use and stays within its budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "k2-v2-frame-entry-"));
  const entry = join(directory, "frame.ts");
  try {
    await Bun.write(
      entry,
      `import { attachWorkspaces } from ${JSON.stringify(resolve(import.meta.dir, "attach.tsx"))};\nattachWorkspaces();\n`,
    );
    const result = await Bun.build({
      entrypoints: [entry],
      outdir: join(directory, "out"),
      target: "browser",
      conditions: ["browser", "production"],
      minify: true,
      splitting: true,
      metafile: true,
      plugins: [
        {
          name: "frame-entry-solid",
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
    if (!result.success || !result.metafile) throw new AggregateError(result.logs, "frame entry build failed");
    const outputs = new Map(Object.entries(result.metafile.outputs).map(([path, output]) => [basename(path), output]));
    const first = [...outputs].find(([, output]) => output.entryPoint && resolve(output.entryPoint) === entry);
    if (!first) throw new Error("frame entry missing");
    const closure = new Set([first[0]]);
    for (const name of closure)
      for (const edge of outputs.get(name)?.imports ?? []) if (edge.kind === "import-statement") closure.add(basename(edge.path));
    const inputs = [...closure].flatMap((name) => Object.keys(outputs.get(name)?.inputs ?? {}));
    expect(inputs.filter((input) => input.includes("@ui-sdk"))).toEqual([]);
    expect(inputs.some((input) => input.endsWith("attach-live.tsx"))).toBe(false);
    // the live parts are one lazy step away
    const lazy = [...outputs.values()].flatMap((output) => Object.keys(output.inputs));
    expect(lazy.some((input) => input.endsWith("attach-live.tsx"))).toBe(true);
    const bytes = [...closure].reduce((sum, name) => sum + (outputs.get(name)?.bytes ?? 0), 0);
    console.info(`frame entry static closure: ${bytes} / ${STATIC_BUDGET} bytes`);
    expect(bytes).toBeLessThanOrEqual(STATIC_BUDGET);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
