import { resolve } from "node:path";

const cwd = resolve(import.meta.dir, "..");
const files = (await Array.fromAsync(new Bun.Glob("test/*.test.ts").scan({ cwd }))).sort();
const browserFiles = files.filter((file) => file.endsWith(".browser.test.ts") || file === "test/runtime.test.ts");
const domFiles = files.filter((file) => file.endsWith(".behavior.test.ts"));
const ssrFiles = files.filter((file) => file.endsWith(".render.test.ts"));
const separate = [...browserFiles, ...domFiles, ...ssrFiles];
const commands = [
  ["test", ...separate.flatMap((file) => ["--path-ignore-patterns", `**/${file.split("/").at(-1)}`]), "./test"],
  ...ssrFiles.map((file) => ["test", `./${file}`]),
  ...browserFiles.map((file) => ["test", `./${file}`]),
  ...domFiles.map((file) => ["test", "--conditions=browser", "--preload", "../ui/test/solid-dom-preload.ts", `./${file}`]),
];

// SSR installs a process-wide plugin; browser builds and workers need a fresh process.
// DOM modules register delegated events against their first document.
// OS processes also avoid Bun's --isolate build-handle errors in these build-heavy suites.
let failed = false;
for (const command of commands) {
  console.log(`Kit tests: ${command.join(" ")}`);
  const child = Bun.spawn([process.execPath, ...command], { cwd, env: process.env, stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) failed = true;
}
if (failed) process.exit(1);
