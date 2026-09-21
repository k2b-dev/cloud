// DOM tests need the browser Solid build; server/render tests need the server build.
const cwd = new URL("../", import.meta.url).pathname;
const files = [...new Bun.Glob("{src,examples}/**/*.test.{ts,tsx}").scanSync({ cwd })].sort().map((path) => `./${path}`);
const isDomTest = (path: string) => path.endsWith(".behavior.test.tsx");
const suites = [
  files.filter((path) => !isDomTest(path)),
  ["--isolate", "--conditions=browser", "--preload", "../ui/test/solid-dom-preload.ts", ...files.filter(isDomTest)],
];
let failed = false;
for (const args of suites) {
  const child = Bun.spawn([process.execPath, "test", ...args], {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) failed = true;
}
if (failed) process.exitCode = 1;
