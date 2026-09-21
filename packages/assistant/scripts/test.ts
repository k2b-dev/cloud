// DOM tests need the browser Solid build; server/render tests need the server build.
const cwd = new URL("../", import.meta.url).pathname;
// Playwright suites (*.browser.test.ts) run in the nightly workflow, not in the unit run.
const files = [...new Bun.Glob("{src,examples}/**/*.test.{ts,tsx}").scanSync({ cwd })]
  .filter((path) => !path.endsWith(".browser.test.ts"))
  .sort()
  .map((path) => `./${path}`);
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
