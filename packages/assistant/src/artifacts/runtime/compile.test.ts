import { expect, test } from "bun:test";
import { compileArtifact, resolveSourceImport } from "./compile";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("production compiler loads the emitted worker asset beside its server bundle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-production-worker-"));
  try {
    const output = join(directory, "compile.js");
    const build = Bun.spawn(["bun", "build", new URL("./compile.ts", import.meta.url).pathname, "--target", "bun", "--outfile", output], {
      env: { ...process.env, NODE_ENV: "production" }, stdout: "pipe", stderr: "pipe",
    });
    const buildErrors = await new Response(build.stderr).text();
    expect(await build.exited, buildErrors).toBe(0);
    const extras = Bun.spawn(["bun", new URL("../../../scripts/build-extras.ts", import.meta.url).pathname], {
      env: { ...process.env, DIST_DIR: directory }, stdout: "pipe", stderr: "pipe",
    });
    const extrasErrors = await new Response(extras.stderr).text();
    expect(await extras.exited, extrasErrors).toBe(0);
    const probe = join(directory, "probe.ts");
    await Bun.write(probe, `import { compileArtifact } from "./compile.js";
      const result = await compileArtifact({entry:"main.ts",files:[{path:"main.ts",content:"export default () => 42;"}]});
      if (!result.runtime.includes("__artifactStart") || !result.code.includes("42")) throw new Error("Invalid production bundle");`);
    const run = Bun.spawn(["bun", probe], { env: { ...process.env, NODE_ENV: "production" }, stdout: "pipe", stderr: "pipe" });
    const runErrors = await new Response(run.stderr).text();
    expect(await run.exited, runErrors).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30000);

test("bundles TypeScript with relative helper modules without running source on the server", async () => {
  const result = await compileArtifact({ entry: "main.ts", files: [
    { path: "main.ts", content: 'import { answer } from "./lib/value.ts"; export default () => answer;' },
    { path: "lib/value.ts", content: "export const answer: number = 42;" },
  ] });
  expect(result.code).toContain("42");
  expect(result.runtime).toContain("__artifactStart");
});

test("rejects external imports, traversal and syntax errors", async () => {
  expect(() => resolveSourceImport("main.js", "../private.js")).toThrow();
  expect(() => resolveSourceImport("main.js", "https://example.com/app.js")).toThrow();
  for (const content of ['import "bun"; export default () => 1;', 'export default () => {'])
    await expect(compileArtifact({ entry: "main.js", files: [{ path: "main.js", content }] })).rejects.toThrow();
});
