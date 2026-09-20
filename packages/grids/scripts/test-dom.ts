import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const files = Array.from(new Bun.Glob("src/**/*.behavior.test.{ts,tsx}").scanSync({ cwd: packageRoot }))
  .sort()
  .map((file) => resolve(packageRoot, file));
if (!files.length) throw new Error("No Grids browser behavior tests found");
// Start from the workspace root to avoid Grids' server-rendering preload.
const child = Bun.spawn(
  [process.execPath, "--no-env-file", "test", "--isolate", "--conditions=browser", "--preload", "./packages/ui/test/solid-dom-preload.ts", ...files],
  { cwd: resolve(packageRoot, "../.."), env: process.env, stdout: "inherit", stderr: "inherit" },
);
process.exit(await child.exited);
