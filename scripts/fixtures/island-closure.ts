import { dirname, resolve } from "node:path";
import { transform } from "../../packages/ssr/src/transform";

/** Re-export barrels carry other modules' exports and no code of their own. */
const barrel = /\bexport\s*\*|\bexport\s*\{[^}]*\}\s*from\b/;

/**
 * A module whose code reaches no output, replaced by its import edges and empty exports. Its code still counts in the
 * minifier's naming of the chunks it touches, so an unused function would change the measured size; the edges keep
 * the module graph, and with it the chunks, as they are.
 */
const stubDeadModule = (path: string, code: string) => {
  const loader = /\.tsx?$/.test(path) ? (path.endsWith("x") ? "tsx" : "ts") : "js";
  const scan = new Bun.Transpiler({ loader }).scan(code);
  const edges = scan.imports
    .filter((entry) => entry.kind === "import-statement")
    .map((entry, index) => `export * as __edge${index} from ${JSON.stringify(entry.path)};`);
  const names = scan.exports.map((name) => (name === "default" ? "export default void 0;" : `export const ${name} = void 0;`));
  return [...edges, ...names].join("\n") || "export {};";
};

/** Source inputs reachable without loading an on-demand chunk. `dead` modules are replaced by `stubDeadModule`. */
export const buildIslandClosure = async (entries: string[], files?: Record<string, string>, dead?: ReadonlySet<string>) => {
  const stubs: string[] = [];
  for (const path of dead ?? []) if (!barrel.test(files?.[path] ?? (await Bun.file(path).text()))) stubs.push(path);
  const result = await Bun.build({
    files,
    entrypoints: entries,
    target: "browser",
    conditions: ["browser", "production"],
    metafile: true,
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    splitting: true,
    plugins: [
      ...(stubs.length
        ? [
            {
              name: "island-closure-dead-modules",
              setup(build: Bun.PluginBuilder) {
                // Only the stubbed paths: a loader that matched every file would keep the Solid transform below from running.
                const filter = new RegExp(`^(?:${stubs.map((path) => path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})$`);
                build.onLoad({ filter }, async ({ path }) => ({
                  contents: stubDeadModule(path, files?.[path] ?? (await Bun.file(path).text())),
                  loader: "js",
                  resolveDir: dirname(path),
                }));
              },
            },
          ]
        : []),
      {
        name: "island-closure-solid-dom",
        setup(build) {
          build.onLoad({ filter: /\.(tsx|jsx)$/ }, async ({ path }) => ({
            contents: await transform(files?.[path] ?? (await Bun.file(path).text()), path, "dom"),
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!result.success) throw new AggregateError(result.logs, "Could not build island import closure");
  if (!result.metafile) throw new Error("Island import closure build returned no metafile");
  return result;
};

/** Source inputs reachable without loading an on-demand chunk. */
export const staticImportClosure = async (entries: string[]): Promise<string[]> => {
  const result = await buildIslandClosure(entries);
  if (!result.metafile) throw new Error("Island import closure build returned no metafile");
  const inputs = new Map(Object.entries(result.metafile.inputs).map(([path, input]) => [resolve(path), { path, input }]));
  const visited = new Set<string>();
  const visit = (path: string): void => {
    const source = inputs.get(resolve(path));
    if (!source || visited.has(source.path)) return;
    visited.add(source.path);
    for (const edge of source.input.imports) {
      if (edge.kind !== "dynamic-import" && !edge.external) visit(edge.path);
    }
  };
  for (const entry of entries) visit(entry);
  return [...visited];
};
