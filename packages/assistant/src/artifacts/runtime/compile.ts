import { env } from "@k2b/cloud/config";
import { ArtifactCompileError, sourceActions } from "../actions";
import { ArtifactSource } from "../contracts";

export function resolveSourceImport(importer: string, specifier: string): string {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) throw new Error("Only relative source imports are available");
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

function resolveSourceFile(importer: string, specifier: string, files: ReadonlyMap<string, string>): string {
  const path = resolveSourceImport(importer, specifier);
  if (files.has(path)) return path;
  const candidates = /\.[^/]+$/.test(path) ? [] : [path + ".ts", path + ".js"].filter((candidate) => files.has(candidate));
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1)
    throw new Error(`Ambiguous import ${JSON.stringify(specifier)} in ${importer}: use ${candidates.join(" or ")} explicitly.`);
  throw new Error(
    `Missing source file for import ${JSON.stringify(specifier)} in ${importer}. Save the referenced module before running the app.`,
  );
}

let runtime: Promise<string> | undefined;
export function runtimeSource(): Promise<string> {
  if (env.NODE_ENV === "production") {
    runtime ??= Bun.file(new URL("./assistant-artifact-worker.js", import.meta.url))
      .text()
      .catch((error) => {
        runtime = undefined;
        throw error;
      });
    return runtime;
  }
  if (!runtime)
    runtime = Bun.build({
      entrypoints: [new URL("./worker.ts", import.meta.url).pathname],
      target: "browser",
      format: "iife",
      minify: true,
      define: { "import.meta.url": JSON.stringify("about:blank") },
    })
      .then(async (build) => {
        if (!build.success) throw new Error(build.logs.join("\n"));
        return build.outputs[0]!.text();
      })
      .catch((error) => {
        runtime = undefined;
        throw error;
      });
  return runtime;
}

export async function compileArtifact(input: unknown, invocation?: { action: string; input?: unknown }) {
  const source = ArtifactSource.parse(input);
  const actions = sourceActions(source);
  const action = invocation ? actions.find((action) => action.name === invocation.action) : undefined;
  if (invocation && !action) throw new ArtifactCompileError(`Unknown app action: ${invocation.action}`);
  const entry = action?.entry ?? source.entry;
  const runtimeCode = await runtimeSource();
  const files = new Map(source.files.map((file) => [file.path, file.content]));
  // An action-only app needs no placeholder UI module. Its manifest and action
  // modules remain the same immutable source bundle as an ordinary GUI app.
  const headless = !invocation && actions.length > 0 && !files.has(entry);
  const build = await Bun.build({
    entrypoints: ["__artifact_entry__"],
    target: "browser",
    format: "iife",
    plugins: [
      {
        name: "artifact-source",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => ({
            path:
              args.path === "__artifact_entry__"
                ? args.path
                : args.importer === "__artifact_entry__"
                  ? entry
                  : resolveSourceFile(args.importer, args.path, files),
            namespace: "artifact",
          }));
          builder.onLoad({ filter: /.*/, namespace: "artifact" }, (args) => {
            const contents =
              args.path === "__artifact_entry__"
                ? headless
                  ? "globalThis.__artifactStart(() => null);"
                  : `import entry from ${JSON.stringify("./" + entry)}; globalThis.__artifactStart(${invocation ? `() => entry(${JSON.stringify(invocation.input ?? null)})` : "entry"});`
                : files.get(args.path);
            if (contents === undefined) throw new Error(`Missing source file: ${args.path}`);
            if (args.path.endsWith(".json")) return { contents, loader: "json" };
            if (/\.(?:csv|tsv|txt)$/.test(args.path)) return { contents, loader: "text" };
            if (args.path !== "__artifact_entry__" && !/\.(?:js|ts)$/.test(args.path))
              throw new Error("Import JavaScript, TypeScript, JSON, CSV, TSV or text files.");
            return { contents, loader: args.path.endsWith(".ts") ? "ts" : "js" };
          });
        },
      },
    ],
  }).catch((error) => {
    throw new ArtifactCompileError(compilationDiagnostic(error));
  });
  if (!build.success) throw new ArtifactCompileError(build.logs.join("\n").slice(0, 16000));
  return { code: await build.outputs[0]!.text(), runtime: runtimeCode };
}

/** Compile every published handler without running any application code. */
export async function validateArtifact(source: ArtifactSource) {
  await compileArtifact(source);
  for (const action of sourceActions(source)) await compileArtifact(source, { action: action.name });
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
