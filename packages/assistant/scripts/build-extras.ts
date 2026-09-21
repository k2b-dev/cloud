import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const output = process.env.DIST_DIR;
if (!output) throw new Error("DIST_DIR is required");
const build = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "../src/artifacts/runtime/worker.ts")],
  target: "browser",
  format: "iife",
  minify: true,
  define: { "import.meta.url": JSON.stringify("about:blank") },
});
if (!build.success) throw new Error(build.logs.join("\n"));
await Bun.write(resolve(output, "assistant-artifact-worker.js"), await build.outputs[0]!.text());

const host = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "../src/artifacts/runtime/cli-host.ts")],
  target: "browser",
  format: "iife",
  minify: true,
});
if (!host.success) throw new Error(host.logs.join("\n"));
await Bun.write(resolve(output, "assistant-cli-host.js"), await host.outputs[0]!.text());

const hostProcess = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "../src/cli/code-host-process.ts")],
  target: "bun",
  format: "esm",
  external: ["playwright"],
});
if (!hostProcess.success) throw new Error(hostProcess.logs.join("\n"));
await Bun.write(resolve(output, "assistant-code-host-process.js"), await hostProcess.outputs[0]!.text());
await mkdir(resolve(output, "node_modules"), { recursive: true });
for (const name of ["playwright", "playwright-core"]) {
  const packagePath = Bun.resolveSync(
    `${name}/package.json`,
    dirname(Bun.resolveSync("playwright/package.json", resolve(import.meta.dir, ".."))),
  );
  await cp(dirname(packagePath), resolve(output, "node_modules", name), { recursive: true });
}
