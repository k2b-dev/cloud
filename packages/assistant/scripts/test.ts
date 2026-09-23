const cwd = new URL("../", import.meta.url).pathname;
// Playwright suites (*.browser.test.ts) run in the nightly workflow, not in the unit run.
// Browser behavior tests (*.behavior.test.tsx) run through the root test runner in browser mode.
const files = [...new Bun.Glob("{src,examples}/**/*.test.{ts,tsx}").scanSync({ cwd })]
  .filter((path) => !path.endsWith(".browser.test.ts") && !/\.behavior\.test\.tsx?$/.test(path))
  .sort()
  .map((path) => `./${path}`);
const child = Bun.spawn([process.execPath, "test", ...files], {
  cwd,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exitCode = await child.exited;
