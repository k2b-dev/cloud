import { cp, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const root = resolve(import.meta.dir, "..");
const manifest = z.object({ optionalDependencies: z.record(z.string(), z.string()) });

/** Build on the target architecture; only canvas and its matching native binary stay external. */
export const buildServer = async () => {
  const output = resolve(root, "server-dist/server");
  await rm(resolve(root, "server-dist"), { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const result = await Bun.build({
    entrypoints: [resolve(root, "server/start.ts")],
    target: "bun",
    outdir: output,
    naming: "start.js",
    minify: true,
    external: ["@napi-rs/canvas"],
  });
  if (!result.success) throw new AggregateError(result.logs, "Notes server build failed");
  const source = await realpath(dirname(Bun.resolveSync("@napi-rs/canvas/package.json", root)));
  const data = manifest.parse(await Bun.file(resolve(source, "package.json")).json());
  const report = z.object({ header: z.object({ glibcVersionRuntime: z.string().optional() }) }).parse(process.report.getReport());
  const platform = `${process.platform}-${process.arch}${process.platform === "linux" ? (report.header.glibcVersionRuntime ? "-gnu" : "-musl") : ""}`;
  const native = `@napi-rs/canvas-${platform}`;
  if (!(native in data.optionalDependencies)) throw new Error("unsupported_canvas_platform");
  const binary = await realpath(dirname(Bun.resolveSync(`${native}/package.json`, source)));
  await cp(source, resolve(output, "node_modules/@napi-rs/canvas"), {
    recursive: true,
    dereference: true,
    filter: (path) => !path.endsWith("/node_modules"),
  });
  await cp(binary, resolve(output, "node_modules", native), { recursive: true, dereference: true });
};

if (import.meta.main) {
  if (process.argv.includes("--help"))
    console.log(
      "Usage: bun pwas/notes/scripts/build-server.ts\nBundles the Notes server and copies the current architecture's native canvas runtime.",
    );
  else await buildServer();
}
