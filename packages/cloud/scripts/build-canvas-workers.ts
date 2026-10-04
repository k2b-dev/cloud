import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Isolated native canvas workers, each packaged only when the server bundle reaches the module that starts it. */
const CANVAS_WORKERS = [
  { reachedBy: "/ai/pdf-render.ts", entry: "src/ai/pdf-render-worker.ts", output: "pdf-worker.js", packages: ["pdfjs-dist"] },
  {
    reachedBy: "/services/branding/app-icons.ts",
    entry: "src/services/branding/icon-render-worker.ts",
    output: "icon-worker.js",
    packages: [],
  },
] as const;

/**
 * Writes `dist/canvas/<worker>.js` for every canvas worker the bundle needs, with one copy of `@napi-rs/canvas`, its
 * installed platform binary and the workers' other packages in `dist/canvas/node_modules`.
 */
export async function buildCanvasWorkers(dist: string, bundledInputs: readonly string[]) {
  const workers = CANVAS_WORKERS.filter((worker) => bundledInputs.some((path) => path.endsWith(worker.reachedBy)));
  if (workers.length === 0) return;
  const framework = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const out = resolve(dist, "canvas");
  await mkdir(out, { recursive: true });
  const external = ["@napi-rs/canvas", ...workers.flatMap((worker) => worker.packages)];
  for (const worker of workers) {
    const build = await Bun.build({
      entrypoints: [resolve(framework, worker.entry)],
      target: "bun",
      outdir: out,
      naming: worker.output,
      external,
    });
    if (!build.success) throw new Error(`Canvas worker ${worker.output} build failed: ${build.logs.join("\n")}`);
  }
  for (const name of external) {
    const source = dirname(Bun.resolveSync(`${name}/package.json`, framework));
    await cp(source, resolve(out, "node_modules", name), { recursive: true, dereference: true });
    if (name !== "@napi-rs/canvas") continue;
    const manifest = z
      .object({ optionalDependencies: z.record(z.string(), z.string()) })
      .parse(await Bun.file(resolve(source, "package.json")).json());
    let nativePackages = 0;
    for (const dependency of Object.keys(manifest.optionalDependencies)) {
      let location: string;
      try {
        location = dirname(Bun.resolveSync(`${dependency}/package.json`, source));
      } catch {
        continue;
      } // Only the installed target-platform binary is needed.
      await cp(location, resolve(out, "node_modules", dependency), { recursive: true, dereference: true });
      nativePackages++;
    }
    if (!nativePackages) throw new Error("Canvas workers need an installed native canvas binary for the build platform.");
  }
}
