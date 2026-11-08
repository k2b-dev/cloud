import type { GeneratedCodeSdk } from "@k2b/cloud/code";
import { env } from "@k2b/cloud/config";
import { z } from "zod";
import { ChunkName, chunkSource } from "./chunks";
import { compileScript } from "./compile";

let prelude: Promise<string> | undefined;
export function runnerPrelude() {
  prelude ??= (async () => {
    if (env.NODE_ENV === "production") return Bun.file(new URL("./assistant-artifact-runner-prelude.js", import.meta.url)).text();
    const built = await Bun.build({
      entrypoints: [new URL("./runner-worker.ts", import.meta.url).pathname],
      target: "browser",
      format: "esm",
      minify: true,
    });
    if (!built.success) throw new Error(built.logs.join("\n"));
    return built.outputs[0]!.text();
  })().catch((error) => {
    prelude = undefined;
    throw error;
  });
  return prelude;
}
export async function compileRunnerScript(source: unknown, sdk?: GeneratedCodeSdk) {
  const compiled = await compileScript(source, sdk, true);
  const modules = Object.fromEntries(await Promise.all(ChunkName.options.map(async (name) => [`${name}.js`, await chunkSource(name)])));
  return {
    bundle: `${await runnerPrelude()}\nObject.defineProperty(globalThis, "__artifactBoot", { value: () => {\n${compiled.runtime}\n} });\nObject.defineProperty(globalThis, "__artifactExecute", { value: () => {\n${compiled.code}\n} });`,
    modules: z.record(z.enum(["csv.js", "sheet.js", "finance.js", "pdf-read.js"]), z.string()).parse(modules),
  };
}
