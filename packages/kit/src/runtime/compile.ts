import { ProjectValidationError } from "../errors";
import { resolveImport, validateProject } from "../project";
let runtime: Promise<string> | undefined;
export function runtimeSource() {
  if (process.env.NODE_ENV === "production") return (runtime ??= Bun.file(new URL("./kit-worker.js", import.meta.url)).text());
  return (runtime ??= Bun.build({
    entrypoints: [`${import.meta.dir}/worker.ts`],
    target: "browser",
    minify: true,
  }).then(async (b) => {
    if (!b.success) throw new Error(b.logs.join("\n"));
    return b.outputs[0]!.text();
  }));
}
export async function compile(input: unknown, entryPath: string) {
  const { project, entries } = validateProject(input);
  if (!entries.some((e) => e.path === entryPath)) throw new ProjectValidationError("entry", "", entryPath);
  const files = new Map(project.files.map((f) => [f.path, f.content]));
  const build = await Bun.build({
    entrypoints: ["__kit_entry__"],
    target: "browser",
    format: "esm",
    plugins: [
      {
        name: "mini-app-source",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => ({
            path: args.importer && args.importer !== "__kit_entry__" ? resolveImport(args.importer, args.path) : args.path,
            namespace: "mini",
          }));
          b.onLoad({ filter: /.*/, namespace: "mini" }, (args) => {
            const contents =
              args.path === "__kit_entry__"
                ? `import definition from ${JSON.stringify(entryPath)}; globalThis.__kitStart(definition);`
                : files.get(args.path);
            if (contents === undefined) throw new ProjectValidationError("missing", args.path);
            return { contents, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new ProjectValidationError("compile", build.logs.join("\n"));
  return {
    runtime: await runtimeSource(),
    code: await build.outputs[0]!.text(),
  };
}
