import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const fixture = join(import.meta.dir, "echo-plugin");

/**
 * Build the echo fixture the way a third-party application publishes a `cld`
 * plugin: `package.json` plus one self-contained ESM bundle that carries its
 * own copy of `@k2b/cloud/cli`.
 */
export const buildEchoPlugin = async (target: string): Promise<string> => {
  await mkdir(target, { recursive: true });
  await copyFile(join(fixture, "package.json"), join(target, "package.json"));
  const result = await Bun.build({
    entrypoints: [join(fixture, "src", "cli.ts")],
    outdir: join(target, "dist"),
    naming: "cli.js",
    target: "bun",
    format: "esm",
  });
  if (!result.success) throw new AggregateError(result.logs, "Failed to build the echo plugin fixture.");
  return target;
};
