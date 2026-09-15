import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Package the decoder and native assets only for bundles importing PDF vision. */
export async function buildPdfRenderer(dist: string) {
  const framework = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const out = resolve(dist, "pdf-render");
  await mkdir(out, { recursive: true });
  const worker = await Bun.build({
    entrypoints: [resolve(framework, "src/ai/pdf-render-worker.ts")],
    target: "bun",
    outdir: out,
    naming: "worker.js",
    external: ["pdfjs-dist", "@napi-rs/canvas"],
  });
  if (!worker.success) throw new Error(`PDF decoder build failed: ${worker.logs.join("\n")}`);
  for (const name of ["pdfjs-dist", "@napi-rs/canvas"]) {
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
    if (!nativePackages) throw new Error("PDF decoder needs an installed native canvas binary for the build platform.");
  }
}
