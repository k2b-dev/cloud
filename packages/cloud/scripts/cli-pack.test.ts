import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCloudCliPluginManifest } from "../src/cli/plugin";

const workspace = await mkdtemp(join(tmpdir(), "cli-pack-test-"));
afterAll(() => rm(workspace, { recursive: true, force: true }));

const runArgs = async (args: string[]) => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "cli-pack.ts"), ...args], {
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const run = (out: string, ...args: string[]) => runArgs(["module.ts", "--references", "references", "--out", out, ...args]);

await writeFile(
  join(workspace, "package.json"),
  JSON.stringify({ name: "pack-test", version: "1.2.3", cld: { manifest: "manifest.json" } }),
);
await writeFile(join(workspace, "module.ts"), 'export default { name: "packed", summary: "Packed test", run: () => 0 };');
await mkdir(join(workspace, "references", "guides"), { recursive: true });
await writeFile(join(workspace, "references", "index.md"), "# Start\n");
await writeFile(join(workspace, "references", "guides", "setup.md"), "# Setup\n");

test("packs the shared bundle contract, keeps nested references and removes stale output", async () => {
  const out = join(workspace, "packed");
  const result = await run(out);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(
    `Packed pack-test@1.2.3 (module "packed", 2 reference files) to ${out}. Ship it with \`npm publish ${out}\` or \`npm pack ${out}\`.`,
  );
  expect((await readdir(out)).sort()).toEqual(["cli.js", "manifest.json", "package.json", "references"]);
  expect(JSON.parse(await readFile(join(out, "package.json"), "utf8"))).toEqual({
    name: "pack-test",
    version: "1.2.3",
    type: "module",
    cld: { manifest: "manifest.json" },
  });
  const manifest = parseCloudCliPluginManifest(JSON.parse(await readFile(join(out, "manifest.json"), "utf8")));
  expect(manifest).toMatchObject({ name: "packed", app: "pack-test", version: "1.2.3" });
  expect(manifest.files.map((file) => file.path)).toEqual(["cli.js", "references/guides/setup.md", "references/index.md"]);
  expect(await readFile(join(out, "references", "guides", "setup.md"), "utf8")).toBe("# Setup\n");
  await writeFile(join(out, "references", "stale.md"), "stale");
  expect((await run(out)).exitCode).toBe(0);
  expect(await Bun.file(join(out, "references", "stale.md")).exists()).toBe(false);
});

test("refuses foreign non-empty output untouched, with one clear error line", async () => {
  const out = join(workspace, "foreign");
  await mkdir(out);
  await writeFile(join(out, "keep.txt"), "keep");
  const result = await run(out);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
  expect(result.stderr).toContain("Refusing --out");
  expect((await readdir(out)).sort()).toEqual(["keep.txt"]);
  expect(await readFile(join(out, "keep.txt"), "utf8")).toBe("keep");
});

test("refuses --out . even with a cld manifest and preserves source files", async () => {
  const paths = ["package.json", "module.ts", "references/index.md", "references/guides/setup.md"];
  const before = await Promise.all(paths.map((path) => readFile(join(workspace, path), "utf8")));
  const result = await run(".");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Refusing --out");
  expect(await Promise.all(paths.map((path) => readFile(join(workspace, path), "utf8")))).toEqual(before);
});

test("refuses an output with a cld manifest and a foreign extra file untouched", async () => {
  const out = join(workspace, "foreign-cld");
  await mkdir(out);
  const pkg = JSON.stringify({ cld: { manifest: "manifest.json" } });
  await writeFile(join(out, "package.json"), pkg);
  await writeFile(join(out, "keep.txt"), "keep");
  const result = await run(out);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Refusing --out");
  expect((await readdir(out)).sort()).toEqual(["keep.txt", "package.json"]);
  expect(await readFile(join(out, "package.json"), "utf8")).toBe(pkg);
  expect(await readFile(join(out, "keep.txt"), "utf8")).toBe("keep");
});

test.each(["module", "references", "directory-alias", "file-alias"] as const)(
  "refuses earlier-looking output containing the %s input without changing it",
  async (input) => {
    const out = join(workspace, `protected-${input}`);
    const alias = join(workspace, `protected-alias-${input}`);
    await mkdir(join(out, "references"), { recursive: true });
    const pkg = JSON.stringify({ cld: { manifest: "manifest.json" } });
    const source = await readFile(join(workspace, "module.ts"), "utf8");
    await writeFile(join(out, "package.json"), pkg);
    await writeFile(join(out, "cli.js"), source);
    await writeFile(join(out, "references", "index.md"), "# Protected\n");
    await symlink(out, alias);
    await symlink(join(workspace, "module.ts"), join(out, "manifest.json"));
    const inputs = {
      module: [join(out, "cli.js"), "references"],
      references: ["module.ts", join(out, "references")],
      "directory-alias": [join(alias, "cli.js"), "references"],
      "file-alias": [join(out, "manifest.json"), "references"],
    } as const;
    const [module, references] = inputs[input];
    const result = await runArgs([module, "--references", references, "--out", out]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Refusing --out");
    expect(await readFile(join(out, "package.json"), "utf8")).toBe(pkg);
    expect(await readFile(join(out, "cli.js"), "utf8")).toBe(source);
    expect(await readFile(join(out, "references", "index.md"), "utf8")).toBe("# Protected\n");
  },
);

test("prints usage with --help", async () => {
  const result = await run(join(workspace, "unused"), "--help");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Usage:");
  expect(await Bun.file(join(workspace, "unused", "manifest.json")).exists()).toBe(false);
});
