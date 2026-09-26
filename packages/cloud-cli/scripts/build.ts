import { chmod, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { buildEnv } from "../src/config";

const root = resolve(import.meta.dir, "../../..");
const env = buildEnv();
const outputDir = resolve(env.outputDir ?? resolve(root, "packages/cloud-cli/dist"));
const version = (env.version ?? "0.0.0-dev").replace(/^cli-v/, "");
const commit =
  env.commit ?? (Bun.spawnSync(["git", "rev-parse", "--short=12", "HEAD"], { cwd: root }).stdout.toString().trim() || "unknown");

const targets = [
  { id: "darwin_arm64", bunTarget: "bun-darwin-arm64" },
  { id: "darwin_x64", bunTarget: "bun-darwin-x64" },
  { id: "linux_arm64", bunTarget: "bun-linux-arm64" },
  { id: "linux_x64", bunTarget: "bun-linux-x64-baseline" },
] as const;

const requestedTargets = new Set((env.targets ?? targets.map((target) => target.id).join(",")).split(","));
const selectedTargets = targets.filter((target) => requestedTargets.has(target.id));

if (selectedTargets.length === 0 || selectedTargets.length !== requestedTargets.size) {
  throw new Error(`Unknown CLD_TARGETS value: ${[...requestedTargets].join(", ")}`);
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

for (const target of selectedTargets) {
  const outfile = resolve(outputDir, `cld_${target.id}`);
  const result = await Bun.build({
    entrypoints: [resolve(root, "packages/cloud-cli/src/index.ts")],
    compile: {
      outfile,
      target: target.bunTarget,
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
    define: {
      __CLD_VERSION__: JSON.stringify(version),
      __CLD_COMMIT__: JSON.stringify(commit),
    },
    minify: true,
    // Startup: precompiled bytecode skips parsing at every launch.
    format: "esm",
    bytecode: true,
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`Failed to build ${target.id}.`);
  }

  await chmod(outfile, 0o755);
  console.log(`Built ${outfile}`);
}
