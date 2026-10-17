import { cp, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readImageRecords } from "../src/services/pdf/image-protocol";

const CANVAS_WORKERS = [
  {
    define: "__CLOUD_PDF_RENDER_WORKER__",
    entry: "src/ai/pdf-render-worker.ts",
    output: "pdf-worker.js",
    packages: ["@napi-rs/canvas", "pdfjs-dist"],
  },
  {
    define: "__CLOUD_ICON_RENDER_WORKER__",
    entry: "src/services/branding/icon-render-worker.ts",
    output: "icon-worker.js",
    packages: ["@napi-rs/canvas"],
  },
  { define: "__CLOUD_PDF_IMAGE_WORKER__", entry: "src/services/pdf/image-worker.ts", output: "image-worker.js", packages: ["sharp"] },
] as const;

/** Server bundle defines: each caller starts its worker from `canvas/` next to `server.js`. */
export const CANVAS_WORKER_DEFINES = Object.fromEntries(
  CANVAS_WORKERS.map((worker) => [worker.define, JSON.stringify(`./canvas/${worker.output}`)]),
);

const Manifest = z.object({
  version: z.string(),
  dependencies: z.record(z.string(), z.string()).default({}),
  optionalDependencies: z.record(z.string(), z.string()).default({}),
  os: z.array(z.string()).optional(),
  cpu: z.array(z.string()).optional(),
  libc: z.array(z.string()).optional(),
});
const matches = (values: string[] | undefined, target: string) =>
  !values || (!values.includes(`!${target}`) && (values.every((value) => value.startsWith("!")) || values.includes(target)));

/**
 * Bundle each reached native worker with only its runtime packages external. Copy their real dependency closures flat,
 * dereferenced and filtered by OS, CPU and libc; reject version collisions and missing native binaries. Smoke-test sharp
 * in the packaged subprocess so the build proves that its native closure loads on this architecture.
 */
export async function buildCanvasWorkers(dist: string, serverCode: string) {
  // A worker ships only when the server code still contains its path, which only the code that starts it carries.
  // Metafile inputs also list tree-shaken modules, and a retained module binding contributes bytes without its caller.
  const workers = CANVAS_WORKERS.filter((worker) => serverCode.includes(`./canvas/${worker.output}`));
  if (workers.length === 0) return;
  const framework = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const out = resolve(dist, "canvas");
  await mkdir(out, { recursive: true });
  for (const worker of workers) {
    const build = await Bun.build({
      entrypoints: [resolve(framework, worker.entry)],
      target: "bun",
      outdir: out,
      naming: worker.output,
      external: [...worker.packages],
    });
    if (!build.success) throw new Error(`Native worker ${worker.output} build failed: ${build.logs.join("\n")}`);
  }
  const libc = z.object({ header: z.object({ glibcVersionRuntime: z.string().optional() }) }).parse(process.report.getReport()).header
    .glibcVersionRuntime
    ? "glibc"
    : "musl";
  const copied = new Map<string, string>();
  const copyPackage = async (name: string, dependent: string, optional = false): Promise<boolean> => {
    let source: string;
    try {
      source = await realpath(dirname(Bun.resolveSync(`${name}/package.json`, dependent)));
    } catch (error) {
      if (optional) return false;
      throw error;
    }
    const manifest = Manifest.parse(await Bun.file(resolve(source, "package.json")).json());
    if (!matches(manifest.os, process.platform) || !matches(manifest.cpu, process.arch) || !matches(manifest.libc, libc)) {
      if (optional) return false;
      throw new Error(`Native worker dependency ${name} does not support the build platform.`);
    }
    const existing = copied.get(name);
    if (existing) {
      if (existing !== manifest.version)
        throw new Error(`Native worker dependency collision: ${name} ${existing} and ${manifest.version}.`);
      return true;
    }
    copied.set(name, manifest.version);
    await cp(source, resolve(out, "node_modules", name), {
      recursive: true,
      dereference: true,
      filter: (path) => basename(path) !== "node_modules",
    });
    for (const dependency of Object.keys(manifest.dependencies)) {
      if (dependency in manifest.optionalDependencies) continue;
      await copyPackage(dependency, source);
    }
    let nativePackages = 0;
    for (const dependency of Object.keys(manifest.optionalDependencies)) {
      if (await copyPackage(dependency, source, true)) {
        if (
          (name === "sharp" && dependency.startsWith("@img/sharp-") && !dependency.startsWith("@img/sharp-libvips-")) ||
          (name === "@napi-rs/canvas" && dependency.startsWith("@napi-rs/canvas-"))
        )
          nativePackages++;
      }
    }
    if ((name === "sharp" || name === "@napi-rs/canvas") && !nativePackages) {
      throw new Error(`Native workers need an installed ${name} binary for the build platform.`);
    }
    return true;
  };
  for (const name of new Set(workers.flatMap((worker) => [...worker.packages]))) await copyPackage(name, framework);
  if (workers.some((worker) => worker.output === "image-worker.js")) await smokeImageWorker(resolve(out, "image-worker.js"));
}

async function smokeImageWorker(entry: string) {
  // A fixed 2x2 RGBA PNG; the build process never loads sharp.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DQAMIMMAYAOOgF/REzMMkAAAAASUVORK5CYII=", "base64");
  const child = Bun.spawn([process.execPath, "--no-env-file", entry], {
    stdin: new Blob([
      `${JSON.stringify({ bytes: png.byteLength, boxes: [{ width: 2, height: 2 }], maxBytes: 4096, timeoutMs: 10_000 })}\n`,
      png,
    ]),
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: process.env.PATH },
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const result = await readImageRecords(child.stdout, { boxes: [{ width: 2, height: 2 }], maxBytes: 4096 });
    if ((await child.exited) !== 0 || !result.ok || result.variants.length !== 1 || !result.variants[0]) {
      throw new Error("Packaged image worker could not convert its PNG: sharp's native dependency closure is incomplete or unusable.");
    }
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await child.exited;
  }
}
