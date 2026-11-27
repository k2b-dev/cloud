// Guards of what every island carries: the error fallback, which loads with each island, brings of @k2b/ui only its own
// v2 modules and the shared intl modules, and a helper an island takes from one module of `@k2b/cloud/shared`
// (`@k2b/cloud/shared/<module>`) brings neither the barrel nor its libraries (zod, liquidjs, marked, the formula engine).
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { transform } from "../../../ssr/src/transform";

/** The modules in the static closure of a browser entry that imports `source`. */
const closureInputs = async (source: string): Promise<string[]> => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-island-imports-"));
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
      plugins: [
        {
          name: "island-imports-solid",
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
    if (!result.success || !result.metafile) throw new AggregateError(result.logs, "island build failed");
    const outputs = new Map(Object.entries(result.metafile.outputs).map(([path, output]) => [basename(path), output]));
    const first = [...outputs].find(([, output]) => output.entryPoint && resolve(output.entryPoint) === entry);
    if (!first) throw new Error("entry missing");
    const closure = new Set([first[0]]);
    for (const name of closure)
      for (const edge of outputs.get(name)?.imports ?? []) if (edge.kind === "import-statement") closure.add(basename(edge.path));
    return [...closure].flatMap((name) =>
      Object.entries(outputs.get(name)?.inputs ?? {})
        .filter(([, input]) => input.bytesInOutput > 0)
        // the metafile names inputs from the working directory
        .map(([path]) => resolve(path)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("the island error fallback brings no v1 module of @k2b/ui and of v2 only its own modules", async () => {
  const fallback = resolve(import.meta.dir, "IslandError.tsx");
  const inputs = await closureInputs(`import F from ${JSON.stringify(fallback)};\nconsole.log(F);\n`);
  // v2 and the shared intl modules; anything else of @k2b/ui is a v1 component or its code
  const v1 = inputs.filter(
    (path) => /packages\/ui\/(?:dist\/browser|src)\//.test(path) && !/\/(?:v2|intl)\/|\/surfaces\/person-color\./.test(path),
  );
  expect(v1).toEqual([]);
  // An app bundles a module that every island loads into its common chunk with all that any island uses of it (#4292),
  // so the fallback's v2 modules are its own: never the button, the marks or the other states.
  const v2 = inputs
    .filter((path) => /packages\/ui\/(?:dist\/browser|src)\/v2\//.test(path))
    .map((path) => basename(path).replace(/\.\w+$/, ""));
  expect(v2.sort()).toEqual(["failed", "icon"]);
}, 60_000);

test("one module of @k2b/cloud/shared brings neither the barrel nor its libraries", async () => {
  // resolved through the package's exports, as an app resolves them
  const module = (name: string) => JSON.stringify(Bun.resolveSync(`@k2b/cloud/shared/${name}`, import.meta.dir));
  const inputs = await closureInputs(
    `import { principalLabel } from ${module("principal-label")};\nimport { formatNumber } from ${module("format")};\nconsole.log(principalLabel, formatNumber);\n`,
  );
  expect(inputs.some((path) => path.endsWith("src/shared/index.ts"))).toBe(false);
  expect(inputs.filter((path) => /\/(?:zod|liquidjs|marked)\/|editor\/src\/formula|contracts\/index\.ts/.test(path))).toEqual([]);
}, 60_000);
