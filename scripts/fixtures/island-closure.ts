import { resolve } from "node:path";
import { transform } from "../../packages/ssr/src/transform";

/** Source inputs reachable without loading an on-demand chunk. */
export const staticImportClosure = async (entries: string[]): Promise<string[]> => {
  const result = await Bun.build({
    entrypoints: entries,
    target: "browser",
    conditions: ["browser", "production"],
    metafile: true,
    splitting: true,
    plugins: [
      {
        name: "island-closure-solid-dom",
        setup(build) {
          build.onLoad({ filter: /\.(tsx|jsx)$/ }, async ({ path }) => ({
            contents: await transform(await Bun.file(path).text(), path, "dom"),
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!result.success) throw new AggregateError(result.logs, "Could not build island import closure");
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
