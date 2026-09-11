import { resolve } from "node:path";
const output = process.env.DIST_DIR;
if (!output) throw new Error("DIST_DIR is required");
const build = await Bun.build({
  entrypoints: [resolve(import.meta.dir,"../src/artifacts/runtime/worker.ts")],
  target: "browser", format: "iife", minify: true,
});
if (!build.success) throw new Error(build.logs.join("\n"));
await Bun.write(resolve(output,"assistant-artifact-worker.js"),await build.outputs[0]!.text());
