import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Bun 1.4.2 minifies a dynamic import of "bun" to `awaitPromise.resolve(globalThis.Bun)`,
// which throws a ReferenceError at runtime (#137). Source runs never see it.
const root = resolve(import.meta.dir, "../../../..");
const mangledBunImport = "Promise.resolve(globalThis.Bun)";
const outdir = await mkdtemp(join(tmpdir(), "notebooks-note-refs-bundle-"));
afterAll(() => rm(outdir, { recursive: true, force: true }));

describe("minified notebooks bundle", () => {
  test("the production build contains no mangled Bun import", async () => {
    const build = Bun.spawn([process.execPath, "run", "packages/cloud/scripts/build.ts"], {
      cwd: root,
      env: { ...process.env, NODE_ENV: "production", APP_ID: "notebooks" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, out, err] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
    expect(exit, `${out}\n${err}`).toBe(0);
    const server = await Bun.file(resolve(root, "dist/server.js")).text();
    expect(server.includes(mangledBunImport), `dist/server.js contains ${mangledBunImport}`).toBe(false);
  }, 120_000);

  test("the minified reindex reaches the database", async () => {
    const bundle = await Bun.build({ entrypoints: [resolve(import.meta.dir, "note-refs.ts")], outdir, target: "bun", minify: true });
    expect(bundle.success, bundle.logs.join("\n")).toBe(true);
    const entry = bundle.outputs[0]!.path;
    const script = `const { reindexAll } = await import(${JSON.stringify(entry)});
const error = await reindexAll().then(() => null, (error) => error);
console.log(error?.name ?? "none");`;
    // A closed loopback port: the first query must fail to connect, not before it.
    const run = Bun.spawn([process.execPath, "-e", script], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: "postgres://cloud:cloud@127.0.0.1:1/notebooks_bundle_test" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, out, err] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
    expect(exit, err).toBe(0);
    expect(out.trim()).toBe("PostgresError");
  }, 60_000);
});
