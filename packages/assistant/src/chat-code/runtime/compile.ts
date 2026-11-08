import type { GeneratedCodeSdk } from "@k2b/cloud/code";
import { env } from "@k2b/cloud/config";
import { ScriptCompileError as ArtifactCompileError } from "../compile-error";
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

const runtimes = new Map<boolean, Promise<string>>();
export function runtimeSource(runner = false): Promise<string> {
  let runtime = runtimes.get(runner);
  if (env.NODE_ENV === "production") {
    runtime ??= Bun.file(new URL(runner ? "./assistant-artifact-runner-worker.js" : "./assistant-artifact-worker.js", import.meta.url))
      .text()
      .catch((error) => {
        runtimes.delete(runner);
        throw error;
      });
    runtimes.set(runner, runtime);
    return runtime;
  }
  if (!runtime)
    runtime = Bun.build({
      entrypoints: [new URL("./worker.ts", import.meta.url).pathname],
      target: "browser",
      format: "iife",
      minify: true,
      define: { "import.meta.url": JSON.stringify("about:blank"), __CLOUD_CODE_RUNNER__: String(runner) },
    })
      .then(async (build) => {
        if (!build.success) throw new Error(build.logs.join("\n"));
        return build.outputs[0]!.text();
      })
      .catch((error) => {
        runtimes.delete(runner);
        throw error;
      });
  runtimes.set(runner, runtime);
  return runtime;
}

export async function compileScript(input: unknown, sdk?: GeneratedCodeSdk, runner = false, invocationInput?: unknown, headless = false) {
  const source = ArtifactSource.parse(input);
  const entry = source.entry;
  if (entry.endsWith(".html")) throw new ArtifactCompileError("Expected a JavaScript or TypeScript script entry");
  const runtimeCode = await runtimeSource(runner);
  const files = new Map(source.files.map((file) => [file.path, file.content]));
  // An action-only app needs no placeholder UI module. Its manifest and action
  // modules remain the same immutable source bundle as an ordinary GUI app.

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
              args.path === "__artifact_entry__" || (sdk && args.path === "@sdk")
                ? args.path
                : args.importer === "__artifact_entry__"
                  ? entry
                  : resolveSourceFile(args.importer, args.path, files),
            namespace: "artifact",
          }));
          builder.onLoad({ filter: /.*/, namespace: "artifact" }, (args) => {
            const contents =
              args.path === "@sdk" && sdk
                ? sdk.runtime + "\nexport const sheet = globalThis.cloud.sheet;"
                : args.path === "__artifact_entry__"
                  ? headless
                    ? "globalThis.__artifactStart(() => null);"
                    : sdk
                      ? `import {__codeSdk} from "@sdk";
                       globalThis.__artifactStart(async (...args) => {
                         __codeSdk.bind({call: async (name, invocation) => {
                           ${runner ? 'if (name === "http.fetch") return globalThis.__artifactHttp(invocation);' : ""}
                           const {call, metadata} = invocation;
                           const stream = ${JSON.stringify(Object.fromEntries(sdk.manifest.operations.flatMap((op) => (op.stream ? [[op.capability, op.stream]] : []))))}[name];
                           if (stream?.direction === "write" && call.input?.file?.size > stream.maxBytes)
                             throw new Error("File exceeds the destination's stream limit.");
                           const direction = stream?.direction;
                           const invoke = direction ? globalThis.__artifactSdkStream : globalThis.cloud.capabilities.run;
                           const envelope = await invoke(name, call.input, {
                             ...(call.target ? {target: call.target} : {}), refs: call.refs, ...metadata
                           }, direction);
                           return ${JSON.stringify(sdk.manifest.operations.filter((op) => op.kind === "query" && op.stream?.direction !== "read").map((op) => op.capability))}.includes(name)
                             ? {data: envelope.data, ...(envelope.page === undefined ? {} : {page: envelope.page})}
                             : envelope.data;
                         }});
                         const {default: entry} = await import(${JSON.stringify("./" + entry)});
                         if (typeof entry !== "function") throw new Error("The entry module must default-export a function: export default (input, { files, signal, progress }) => result. An exported object is not executable.");
                         return entry(...args);
                       });`
                      : `import entry from ${JSON.stringify("./" + entry)}; globalThis.__artifactStart(${invocationInput !== undefined ? `entry, ${JSON.stringify(invocationInput)}` : "entry"});`
                  : files.get(args.path);
            if (contents === undefined) throw new Error(`Missing source file: ${args.path}`);
            if (args.path.endsWith(".json")) return { contents, loader: "json" };
            if (/\.(?:csv|tsv|txt)$/.test(args.path)) return { contents, loader: "text" };
            if (args.path !== "__artifact_entry__" && args.path !== "@sdk" && !/\.(?:js|ts)$/.test(args.path))
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
