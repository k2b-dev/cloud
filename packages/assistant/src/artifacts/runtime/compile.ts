import { ArtifactSource } from "../contracts";

export function resolveSourceImport(importer: string, specifier: string): string {
  if (!specifier.startsWith("./") && !specifier.startsWith("../"))
    throw new Error("Only relative source imports are available");
  const parts = importer.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new Error("Import escapes the artifact");
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

let runtime: Promise<string> | undefined;
export function runtimeSource(): Promise<string> {
  if (process.env.NODE_ENV === "production")
    return runtime ??= Bun.file(new URL("./assistant-artifact-worker.js", import.meta.url)).text().catch((error) => {
      runtime = undefined; throw error;
    });
  if (!runtime) runtime = Bun.build({
    entrypoints: [new URL("./worker.ts", import.meta.url).pathname],
    target: "browser", format: "iife", minify: true,
  }).then(async (build) => {
    if (!build.success) throw new Error(build.logs.join("\n"));
    return build.outputs[0]!.text();
  }).catch((error) => { runtime = undefined; throw error; });
  return runtime;
}

export async function compileArtifact(input: unknown) {
  const source = ArtifactSource.parse(input);
  const runtimeCode = await runtimeSource();
  const files = new Map(source.files.map((file) => [file.path, file.content]));
  const build = await Bun.build({
    entrypoints: ["__artifact_entry__"], target: "browser", format: "iife",
    plugins: [{ name: "artifact-source", setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => ({
        path: args.path === "__artifact_entry__" ? args.path
          : args.importer === "__artifact_entry__" ? source.entry
          : resolveSourceImport(args.importer, args.path),
        namespace: "artifact",
      }));
      builder.onLoad({ filter: /.*/, namespace: "artifact" }, (args) => {
        const contents = args.path === "__artifact_entry__"
          ? `import run from ${JSON.stringify("./" + source.entry)}; globalThis.__artifactStart(run);`
          : files.get(args.path);
        if (contents === undefined) throw new Error(`Missing source file: ${args.path}`);
        if (args.path !== "__artifact_entry__" && !/\.(?:js|ts)$/.test(args.path))
          throw new Error("Only JavaScript and TypeScript modules can be imported");
        return { contents, loader: args.path.endsWith(".ts") ? "ts" : "js" };
      });
    } }],
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
  return { code: await build.outputs[0]!.text(), runtime: runtimeCode };
}

/** Keep compiler messages useful to the author instead of dropping AggregateError details. */
export function compilationDiagnostic(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map(compilationDiagnostic).join("\n").slice(0, 16000);
  if (error && typeof error === "object" && "message" in error) {
    let location = "";
    if ("position" in error && error.position && typeof error.position === "object") {
      const position = error.position;
      if ("file" in position) location = String(position.file);
      if ("line" in position) location += `:${position.line}`;
      if ("column" in position) location += `:${position.column}`;
    }
    return `${location ? location + " " : ""}${String(error.message)}`.slice(0, 16000);
  }
  return String(error).slice(0, 16000);
}
