/** Production bundle of the public-site example and its measurement server, built with the example's own SSR plugin. */
import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const outdir = Bun.argv[2];
if (!outdir) throw new Error("usage: bun scripts/fixtures/lighthouse-public-site.build.ts <outdir>");
const cloud = resolve(import.meta.dir, "../../packages/cloud");
const { app } = await import(resolve(cloud, "examples/public-site/src/config"));
// Same ordering as the platform build (packages/cloud/scripts/build.ts): the tsyringe polyfill loads first.
const entry = resolve(outdir, ".server-entry.ts");
await writeFile(
  entry,
  `import ${JSON.stringify(Bun.resolveSync("reflect-metadata", cloud))};\nimport ${JSON.stringify(resolve(import.meta.dir, "lighthouse-public-site.server.ts"))};\n`,
);
try {
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    naming: "server.js",
    target: "bun",
    plugins: [app.plugin()],
    minify: true,
  });
  if (!result.success) throw new AggregateError(result.logs, "Public-site bundle failed");
} finally {
  await rm(entry, { force: true });
}
