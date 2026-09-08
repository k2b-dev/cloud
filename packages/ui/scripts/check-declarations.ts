import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const output = mkdtempSync(join(tmpdir(), "k2b-ui-declarations-"));

try {
  const result = Bun.spawnSync({
    cmd: [
      resolve(packageRoot, "node_modules/.bin/tsc"),
      "-p",
      resolve(packageRoot, "tsconfig.build.json"),
      "--outDir",
      output,
      "--pretty",
      "false",
    ],
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);
} finally {
  rmSync(output, { recursive: true, force: true });
}
