// Production build of the demo (server + islands); prints the island bundle sizes. Usage: NODE_ENV=production bun --conditions=solid scripts/build.ts
import { gzipSync } from "bun";
import { readdirSync, statSync } from "node:fs";
import { plugin } from "../src/config";

const outdir = `${import.meta.dir}/../dist`;
const result = await Bun.build({ entrypoints: [`${import.meta.dir}/../src/server.tsx`], target: "bun", outdir, conditions: ["solid"], plugins: [plugin()] });
if (!result.success) throw new AggregateError(result.logs, "build failed");
const dir = readdirSync(`${outdir}/_ssr`).find((name) => statSync(`${outdir}/_ssr/${name}`).isDirectory());
const assets = `${outdir}/_ssr/${dir}`;
let raw = 0;
let gz = 0;
for (const name of readdirSync(assets).filter((name) => name.endsWith(".js"))) {
  const bytes = await Bun.file(`${assets}/${name}`).bytes();
  raw += bytes.length;
  gz += gzipSync(bytes).length;
  console.log(`${name.padEnd(28)} ${(bytes.length / 1024).toFixed(1).padStart(7)} KB  gzip ${(gzipSync(bytes).length / 1024).toFixed(1).padStart(6)} KB`);
}
console.log(`total island JS: ${(raw / 1024).toFixed(1)} KB, gzip ${(gz / 1024).toFixed(1)} KB`);
