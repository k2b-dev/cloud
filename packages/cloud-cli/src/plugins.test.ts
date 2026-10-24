import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { cloudCliPluginDigest, validateCloudCliModule } from "@k2b/cloud/cli";
import { buildEchoPlugin, packInlinePlugin } from "../test/fixtures/build-plugin";
import { hasStoredPlugin, loadStoredPlugin, placePlugin, storePlugin } from "./plugin-store";
import {
  legacyPlugins,
  PluginError,
  readPackagePluginFile,
  readPackagePlugins,
  removePlugin,
  stagePlugin,
  writePackagePlugins,
} from "./plugins";

const workspace = await mkdtemp(join(tmpdir(), "cld-plugins-test-"));
const echoBuild = await buildEchoPlugin(join(workspace, "echo-build"));
let counter = 0;
const tempDir = async () => {
  const dir = join(workspace, `case-${++counter}`);
  await mkdir(dir);
  return dir;
};
afterAll(() => rm(workspace, { recursive: true, force: true }));
const runCli = async (args: string[], configHome: string, config = join(configHome, "config.json")) => {
  const child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "index.ts"), ...args], {
    env: {
      ...process.env,
      HOME: configHome,
      CLD_LOCALE: "",
      LC_ALL: "",
      LC_MESSAGES: "",
      LANG: "C",
      XDG_CONFIG_HOME: configHome,
      CLD_CONFIG: config,
      TMPDIR: configHome,
    },
    stdin: "ignore",
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
const moduleSource = (name: string) =>
  `export default { name: ${JSON.stringify(name)}, summary: "Fake", requiresCloud: false, run: (ctx) => ctx.print("ran ${name}") };`;
const expectPluginError = async (promise: Promise<unknown>, status: PluginError["status"], message: string) => {
  const error: unknown = await promise.catch((error) => error);
  expect(error).toBeInstanceOf(PluginError);
  if (!(error instanceof PluginError)) throw new Error("expected PluginError");
  expect(error.status).toBe(status);
  expect(error.message).toContain(message);
};
// Minimal ustar entries preserve unsafe member names that tar's writer normalizes.
const tarEntry = (name: string, content = "", link?: string): Buffer => {
  const header = Buffer.alloc(512);
  const bytes = Buffer.from(content);
  header.write(name, 0, 100);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.fill(" ", 148, 156);
  header.write(link ? "2" : "0", 156);
  if (link) header.write(link, 157, 100);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
};
const installStaged = async (spec: string, root: string, registry?: string) => {
  const staged = await stagePlugin(spec, { registry });
  try {
    const stored = await storePlugin(staged.manifest, (file) => readPackagePluginFile(staged, file), root);
    await placePlugin(stored.incoming, staged.manifest.digest, root);
    await writePackagePlugins(
      {
        [staged.manifest.name]: {
          package: staged.manifest.app,
          version: staged.manifest.version,
          digest: staged.manifest.digest,
          summary: stored.module.summary,
          source: staged.source,
        },
      },
      root,
    );
    return staged.manifest;
  } finally {
    await staged.cleanup();
  }
};

describe("package bundles", () => {
  test("rejects invalid JSON in package plugin records", async () => {
    const root = await tempDir();
    const path = join(root, "packages.json");
    await writeFile(path, "{invalid");
    await expectPluginError(readPackagePlugins(root), "error", `Cannot read the package plugin records ${path} (`);
    await expect(readPackagePlugins(root)).rejects.toThrow("Fix or delete the file; deleting it forgets every installed package plugin.");
  });

  test.each(["[]", "null", "42", '"text"', "true"])("rejects non-object package plugin records: %s", async (json) => {
    const root = await tempDir();
    const path = join(root, "packages.json");
    await writeFile(path, json);
    await expectPluginError(readPackagePlugins(root), "error", `Cannot read the package plugin records ${path} (`);
  });

  test("rejects package plugin record read errors other than ENOENT", async () => {
    const root = await tempDir();
    const path = join(root, "packages.json");
    await mkdir(path);
    await expectPluginError(readPackagePlugins(root), "error", `Cannot read the package plugin records ${path} (`);
  });

  test("returns no package plugin records when the file is missing", async () => {
    expect(await readPackagePlugins(await tempDir())).toEqual({});
  });

  test("stages metadata without importing and rejects old formats with incompatible status", async () => {
    const staged = await stagePlugin(echoBuild);
    expect(staged.manifest).toMatchObject({ name: "echo", app: "@k2b-test/cld-plugin-echo", version: "1.0.0" });
    await staged.cleanup();
    const dir = await tempDir();
    for (const cld of [undefined, { apiVersion: 1, entry: "cli.js" }, { apiVersion: 2, entry: "cli.js" }]) {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "old", version: "1.0.0", cld }));
      await expectPluginError(stagePlugin(dir), "incompatible", "old@1.0.0 uses the old plugin format without a verified bundle");
      const refused = await runCli(["plugins", "install", dir, "--yes"], dir);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr.trim().split("\n")).toHaveLength(1);
      expect(refused.stderr).toContain("cli-pack.ts");
    }
  });

  test("shares API compatibility, checks manifest paths and drops malformed records", async () => {
    const dir = await tempDir();
    await cp(echoBuild, join(dir, "package"), { recursive: true });
    const pkg = join(dir, "package");
    const raw = await Bun.file(join(pkg, "package.json")).json();
    for (const manifest of ["../manifest.json", "/manifest.json"]) {
      await writeFile(join(pkg, "package.json"), JSON.stringify({ ...raw, cld: { manifest } }));
      await expectPluginError(stagePlugin(pkg), "error", "relative file path inside the package");
    }
    await writeFile(join(pkg, "package.json"), JSON.stringify(raw));
    const manifest = await Bun.file(join(pkg, "manifest.json")).json();
    await writeFile(join(pkg, "manifest.json"), JSON.stringify({ ...manifest, apiVersion: 2 }));
    await expectPluginError(stagePlugin(pkg), "incompatible", "needs plugin API 2");
    await writeFile(
      join(dir, "packages.json"),
      JSON.stringify({
        bad: { digest: "bad" },
        echo: { package: "echo", version: "1", digest: "a".repeat(128), source: pkg, summary: "Echo" },
      }),
    );
    expect(Object.keys(await readPackagePlugins(dir))).toEqual(["echo"]);
  });

  test("refuses package metadata that is not a regular file instead of blocking or reading forever", async () => {
    const fifo = (path: string) => expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
    const packageFifo = join(await tempDir(), "package");
    await cp(echoBuild, packageFifo, { recursive: true });
    await rm(join(packageFifo, "package.json"));
    fifo(join(packageFifo, "package.json"));
    await expectPluginError(stagePlugin(packageFifo), "error", "package.json must be a regular file");
    const packageZero = join(await tempDir(), "package");
    await cp(echoBuild, packageZero, { recursive: true });
    await rm(join(packageZero, "package.json"));
    await symlink("/dev/zero", join(packageZero, "package.json"));
    await expectPluginError(stagePlugin(packageZero), "error", "package.json must be a regular file");
    const manifestFifo = join(await tempDir(), "package");
    await cp(echoBuild, manifestFifo, { recursive: true });
    await rm(join(manifestFifo, "manifest.json"));
    fifo(join(manifestFifo, "manifest.json"));
    await expectPluginError(stagePlugin(manifestFifo), "error", "plugin manifest manifest.json must be a regular file");
    // tar recreates FIFO members; the archive path must refuse them as well.
    const dir = await tempDir();
    await cp(echoBuild, join(dir, "package"), { recursive: true });
    await rm(join(dir, "package", "package.json"));
    fifo(join(dir, "package", "package.json"));
    const archive = join(dir, "fifo.tgz");
    expect(Bun.spawnSync(["tar", "-czf", archive, "-C", dir, "package"]).exitCode).toBe(0);
    await expectPluginError(stagePlugin(archive), "error", "package.json must be a regular file");
  });

  test("validates modules and short-name metadata structurally", () => {
    const plain = { name: "inventory", summary: "Inventory", run: () => 0 };
    expect(validateCloudCliModule(plain)).toBe(plain);
    expect(() => validateCloudCliModule(undefined)).toThrow("not a CLI module");
    expect(() => validateCloudCliModule({ ...plain, name: "Inventory" })).toThrow("kebab-case");
    expect(() => validateCloudCliModule({ ...plain, run: undefined })).toThrow("run function");
    expect(() => validateCloudCliModule({ ...plain, booleanFlags: [1] })).toThrow("booleanFlags");
    for (const alias of [null, 1, "", "Inv", "inventory", "inv_name"])
      expect(() => validateCloudCliModule({ ...plain, alias })).toThrow("alias");
    for (const shortcuts of [
      null,
      [],
      "stock",
      new Map(),
      new Date(),
      { Stock: "items list" },
      { "1stock": "items list" },
      { stock_name: "items list" },
      { inventory: "items list" },
      { inv: "items list" },
      { stock: null },
      { stock: 1 },
      { stock: "" },
      { stock: "  " },
      { stock: "items --json" },
      { stock: "-h" },
    ]) {
      expect(() => validateCloudCliModule({ ...plain, alias: "inv", shortcuts })).toThrow("shortcuts");
    }
    expect(validateCloudCliModule({ ...plain, shortcuts: { stock: "unknown path" } }).shortcuts).toEqual({ stock: "unknown path" });
  });

  test("installs npm-layout tarballs, checks npm integrity and uses the same store", async () => {
    const dir = await tempDir();
    await cp(echoBuild, join(dir, "package"), { recursive: true });
    const archive = join(dir, "echo.tgz");
    expect(Bun.spawnSync(["tar", "-czf", archive, "-C", dir, "package"]).exitCode).toBe(0);
    const bytes = await readFile(archive);
    let integrity = `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;
    const registry: ReturnType<typeof Bun.serve> = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/@k2b-test%2fcld-plugin-echo/latest")
          return Response.json({ version: "1.0.0", dist: { tarball: `${registry.url.origin}/echo.tgz`, integrity } });
        if (path === "/echo.tgz") return new Response(bytes);
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const root = join(dir, "npm-plugins");
      const manifest = await installStaged("npm:@k2b-test/cld-plugin-echo", root, registry.url.origin);
      expect(await hasStoredPlugin(manifest.digest, root)).toBe(true);
      expect((await loadStoredPlugin("echo", manifest, root)).name).toBe("echo");
      expect((await readPackagePlugins(root)).echo).toMatchObject({ source: "npm:@k2b-test/cld-plugin-echo@1.0.0" });
      const cli = await runCli(["plugins", "install", archive, "--yes", "--json"], dir);
      expect(cli.exitCode, cli.stderr).toBe(0);
      expect(JSON.parse(cli.stdout)).toMatchObject({ id: "echo", source: archive, references: 2 });
      expect((await runCli(["echo", "reference", "guides/setup.md"], dir)).stdout).toContain("# Echo setup");
      integrity = "sha512-wrong";
      await expectPluginError(
        stagePlugin("npm:@k2b-test/cld-plugin-echo", { registry: registry.url.origin }),
        "error",
        "integrity mismatch",
      );
      await expectPluginError(stagePlugin("npm:@k2b-test/missing@2.0.0", { registry: registry.url.origin }), "error", "returned 404");
      await expectPluginError(stagePlugin("npm:Not A Package"), "error", "not an npm package name");
      await expectPluginError(stagePlugin("./missing-plugin"), "error", "does not exist; use npm:<package>");
    } finally {
      await registry.stop(true);
    }
  });
});

describe("cld package plugins", () => {
  test("directory install stores references, updates skills, runs, lists metadata offline and removes", async () => {
    const dir = await tempDir();
    const root = join(dir, "cloud", "cld", "plugins");
    const target = join(dir, "skills");
    expect((await runCli(["skills", "add", target], dir)).exitCode).toBe(0);
    const refused = await runCli(["plugins", "install", echoBuild], dir);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("pass --yes");
    const installed = await runCli(["plugins", "install", echoBuild, "--yes", "--json"], dir);
    expect(installed.exitCode, installed.stderr).toBe(0);
    expect(JSON.parse(installed.stdout)).toEqual({
      id: "echo",
      package: "@k2b-test/cld-plugin-echo",
      version: "1.0.0",
      source: echoBuild,
      references: 2,
      replaced: false,
    });
    expect(installed.stderr).toContain(`@k2b-test/cld-plugin-echo@1.0.0 from ${echoBuild}`);
    expect(installed.stderr).toContain('module "echo", 2 reference files');
    expect(installed.stderr).toContain("runs inside cld with your Cloud credentials");
    const record = (await readPackagePlugins(root)).echo!;
    expect(await hasStoredPlugin(record.digest, root)).toBe(true);
    expect(await readdir(root)).toEqual(expect.arrayContaining(["store", "packages.json"]));
    expect(await Bun.file(join(root, "echo", "package.json")).exists()).toBe(false);
    const skill = join(target, "cloud-cli");
    expect(await readFile(join(skill, "SKILL.md"), "utf8")).toContain(
      "| * | echo | 1.0.0 | Echo the host CLI context (test plugin). | `references/echo/1.0.0/index.md` |",
    );
    expect(await readFile(join(skill, "references", "echo", "1.0.0", "guides", "setup.md"), "utf8")).toContain("# Echo setup");
    expect((await runCli(["echo", "reference"], dir)).stdout).toContain("# Echo package");
    expect((await runCli(["echo", "reference", "guides/setup.md"], dir)).stdout).toContain("# Echo setup");
    expect((await runCli(["echo", "reference", "../package.json"], dir)).exitCode).toBe(1);
    const help = await runCli(["help"], dir);
    expect(help.stdout).toMatch(/\n {2}echo +Echo the host CLI context/);
    // Help lists recorded summaries without importing installed code.
    const entry = join(root, "store", record.digest, "cli.js");
    const code = await readFile(entry);
    await writeFile(entry, 'throw new Error("help imported code");');
    expect((await runCli(["help"], dir)).exitCode).toBe(0);
    await writeFile(entry, code);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        Response.json({ authorization: request.headers.get("authorization"), locale: request.headers.get("accept-language") }),
    });
    try {
      for (const command of [["echo"], ["plugins", "run", "echo"]]) {
        const ran = await runCli(
          ["--server", server.url.origin, "--token", "plugin-token", "--locale", "de", ...command, "whoami", "--json"],
          dir,
        );
        expect(ran.exitCode, ran.stderr).toBe(0);
        expect(JSON.parse(ran.stdout)).toMatchObject({ authorization: "Bearer plugin-token", locale: "de", output: "json" });
      }
    } finally {
      await server.stop(true);
    }
    expect(JSON.parse((await runCli(["plugins", "install", echoBuild, "--yes", "--json"], dir)).stdout).replaced).toBe(true);
    expect((await runCli(["help"], dir, join(dir, "other-config.json"))).stdout).toContain("Echo the host CLI context");
    const listed = await runCli(["plugins", "list", "--json"], dir);
    expect(JSON.parse(listed.stdout).plugins).toContainEqual({
      profile: null,
      name: "echo",
      app: record.package,
      installed: record.version,
      available: null,
      status: "ok",
      source: echoBuild,
      alias: null,
      shortcuts: {},
      inactive: [],
    });
    const update = await runCli(["plugins", "update", "echo"], dir);
    expect(update.exitCode).toBe(1);
    expect(update.stderr).toContain(`cld plugins install ${echoBuild}`);
    expect((await runCli(["plugins", "remove", "echo"], dir)).exitCode).toBe(0);
    expect(await readPackagePlugins(root)).toEqual({});
    expect(await readdir(join(root, "store"))).toEqual([record.digest]);
    expect(await readFile(join(skill, "SKILL.md"), "utf8")).not.toContain("| * | echo |");
    expect(await Bun.file(join(skill, "references", "echo", "1.0.0", "index.md")).exists()).toBe(false);
    expect((await runCli(["plugins", "run", "missing"], dir)).stderr).toContain('Plugin "missing" is not installed.');
  }, 30_000);

  test("rejects tampering, links, unlisted references, missing index and mismatched package metadata without changing installations", async () => {
    const dir = await tempDir();
    const root = join(dir, "cloud", "cld", "plugins");
    expect((await runCli(["plugins", "install", echoBuild, "--yes"], dir)).exitCode).toBe(0);
    const records = await readFile(join(root, "packages.json"), "utf8");
    const store = await readdir(join(root, "store"));
    const mutations: Array<(pkg: string) => Promise<unknown>> = [
      (pkg) =>
        writeFile(
          join(pkg, "references", "index.md"),
          "x".repeat(Buffer.byteLength("# Echo package\n\nUse `cld echo whoami` to inspect the host context.\n")),
        ),
      (pkg) => symlink("index.md", join(pkg, "references", "link.md")),
      (pkg) => symlink("references", join(pkg, "extra-link")),
      (pkg) => writeFile(join(pkg, "references", "binary.txt"), "no"),
      (pkg) => writeFile(join(pkg, "references", "unlisted.md"), "no"),
      (pkg) => rm(join(pkg, "references", "index.md")),
      async (pkg) => {
        const m = await Bun.file(join(pkg, "manifest.json")).json();
        m.files = m.files.filter((file: { path: string }) => file.path !== "references/index.md");
        m.digest = cloudCliPluginDigest(m.files);
        await writeFile(join(pkg, "manifest.json"), JSON.stringify(m));
      },
      async (pkg) => {
        const m = await Bun.file(join(pkg, "manifest.json")).json();
        m.app = "other";
        await writeFile(join(pkg, "manifest.json"), JSON.stringify(m));
      },
      async (pkg) => {
        const m = await Bun.file(join(pkg, "manifest.json")).json();
        m.version = "other";
        await writeFile(join(pkg, "manifest.json"), JSON.stringify(m));
      },
    ];
    for (const mutate of mutations) {
      const pkg = join(await tempDir(), "package");
      await cp(echoBuild, pkg, { recursive: true });
      await mutate(pkg);
      const refused = await runCli(["plugins", "install", pkg, "--yes"], dir);
      expect(refused.exitCode, refused.stdout + refused.stderr).toBe(1);
      expect(await readFile(join(root, "packages.json"), "utf8")).toBe(records);
      expect(await readdir(join(root, "store"))).toEqual(store);
    }
  }, 30_000);

  test("reports missing package metadata and manifests as PluginErrors", async () => {
    const dir = await tempDir();
    await expectPluginError(stagePlugin(dir), "error", "cannot read package.json (");
    await cp(echoBuild, dir, { recursive: true });
    await rm(join(dir, "manifest.json"));
    await expectPluginError(stagePlugin(dir), "error", "cannot read plugin manifest manifest.json (");
  });

  test("tar refusals preserve archives, outside files and installed records", async () => {
    const dir = await tempDir();
    const root = join(dir, "cloud", "cld", "plugins");
    expect((await runCli(["plugins", "install", echoBuild, "--yes"], dir)).exitCode).toBe(0);
    const records = await readFile(join(root, "packages.json"), "utf8");
    const store = await readdir(join(root, "store"));
    const outside = join(dir, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep.md"), "keep");
    const traversal = tarEntry("package/../../escape.md", "escaped");
    const attacks = [
      Buffer.concat([tarEntry("package/link", "", outside), tarEntry("package/link/evil.md", "evil"), traversal]),
      traversal,
    ];
    for (const [index, attack] of attacks.entries()) {
      const archive = join(dir, `malicious-${index}.tgz`);
      const bytes = gzipSync(Buffer.concat([attack, Buffer.alloc(1024)]));
      await writeFile(archive, bytes);
      const refused = await runCli(["plugins", "install", archive, "--yes"], dir);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr.trim().split("\n")).toHaveLength(1);
      expect(refused.stderr).toContain(`Cannot unpack ${archive}: `);
      expect(refused.stderr).not.toContain("Command failed:");
      expect(await readFile(archive)).toEqual(bytes);
      expect(await readdir(outside)).toEqual(["keep.md"]);
      expect(await readFile(join(outside, "keep.md"), "utf8")).toBe("keep");
      expect(await Bun.file(join(dir, "escape.md")).exists()).toBe(false);
      expect((await readdir(dir)).filter((entry) => entry.startsWith("cld-plugin-"))).toEqual([]);
      expect(await readFile(join(root, "packages.json"), "utf8")).toBe(records);
      expect(await readdir(join(root, "store"))).toEqual(store);
    }
    // Tar accepts a symlink member itself; bundle verification must reject it.
    await cp(echoBuild, join(dir, "package"), { recursive: true });
    await symlink("/etc/hostname", join(dir, "package", "references", "guide.md"));
    const archive = join(dir, "symlink.tgz");
    expect(Bun.spawnSync(["tar", "-czf", archive, "-C", dir, "package"]).exitCode).toBe(0);
    const bytes = await readFile(archive);
    const refused = await runCli(["plugins", "install", archive, "--yes"], dir);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("contains a symlink");
    expect(await readFile(archive)).toEqual(bytes);
    expect(await readFile(join(root, "packages.json"), "utf8")).toBe(records);
    expect(await readdir(join(root, "store"))).toEqual(store);
  });

  test("missing package store entries use the recorded source in command and reference hints", async () => {
    const dir = await tempDir();
    const root = join(dir, "cloud", "cld", "plugins");
    const installed = await runCli(["plugins", "install", echoBuild, "--yes"], dir);
    expect(installed.exitCode, installed.stderr).toBe(0);
    const record = (await readPackagePlugins(root)).echo!;
    await rm(join(root, "store", record.digest), { recursive: true });
    for (const args of [
      ["echo", "whoami"],
      ["echo", "reference"],
    ]) {
      const result = await runCli(args, dir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`Run \`cld plugins install ${record.source}\``);
      expect(result.stderr).not.toContain("Run `cld plugins install echo`");
    }
    // `plugins update` names a path source as recorded, but an npm source without its pinned version.
    const local = await runCli(["plugins", "update", "echo"], dir);
    expect(local.exitCode).toBe(1);
    expect(local.stderr).toContain(`\`cld plugins install ${record.source}\``);
    await writePackagePlugins({ echo: { ...record, source: `npm:${record.package}@${record.version}` } }, root);
    const npm = await runCli(["plugins", "update", "echo"], dir);
    expect(npm.exitCode).toBe(1);
    expect(npm.stderr).toContain(`\`cld plugins install npm:${record.package}\`.`);
  });

  test("package installs and removals share a lock across different config directories", async () => {
    const dir = await tempDir();
    const root = join(dir, "cloud", "cld", "plugins");
    const configA = join(dir, "a", "config.json");
    const configB = join(dir, "b", "config.json");
    expect((await runCli(["plugins", "install", echoBuild, "--yes"], dir, configA)).exitCode).toBe(0);
    const pkg = await packInlinePlugin(join(dir, "other"), moduleSource("other"));
    const packagesLock = join(root, ".locks", "packages.lock");
    await mkdir(packagesLock);
    await writeFile(join(packagesLock, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: 0 }));
    const pending = [runCli(["plugins", "remove", "echo"], dir, configA), runCli(["plugins", "install", pkg, "--yes"], dir, configB)];
    let results: Awaited<ReturnType<typeof runCli>>[];
    try {
      const owners = ["a", "b"].map((config) => join(dir, config, "locks", "config.lock", "owner.json"));
      // Wait until both commands hold their config lock; stay well below the 15 s lock timeout.
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !(await Promise.all(owners.map((path) => Bun.file(path).exists()))).every(Boolean)) {
        await Bun.sleep(20);
      }
      expect(await Promise.all(owners.map((path) => Bun.file(path).exists()))).toEqual([true, true]);
      expect(Object.keys(await readPackagePlugins(root))).toEqual(["echo"]);
    } finally {
      await rm(packagesLock, { recursive: true, force: true });
      results = await Promise.all(pending);
    }
    for (const result of results) expect(result.exitCode, result.stderr).toBe(0);
    const records = await readPackagePlugins(root);
    expect(Object.keys(records)).toEqual(["other"]);
    expect(await hasStoredPlugin(records.other!.digest, root)).toBe(true);
    expect(await readdir(join(root, "store"))).toContain(records.other!.digest);
    expect(await readdir(join(root, ".locks"))).toEqual([]);
  }, 30_000);

  test("profile removal preserves published bundles in the shared store", async () => {
    const dir = await tempDir();
    const root = join(dir, "cloud", "cld", "plugins");
    const config = join(dir, "config.json");
    await writeFile(config, JSON.stringify({ currentProfile: "a", profiles: { a: {}, b: {} } }));
    const unused = join(root, "store", "c".repeat(128));
    await mkdir(unused, { recursive: true });
    const packagesLock = join(root, ".locks", "packages.lock");
    await mkdir(packagesLock, { recursive: true });
    await writeFile(join(packagesLock, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: 0 }));
    const pending = runCli(["profile", "rm", "b", "--yes"], dir);
    try {
      // The profile is saved before the sweep; wait for that, then give an unlocked sweep time to run.
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && JSON.parse(await readFile(config, "utf8")).profiles.b) await Bun.sleep(20);
      expect(JSON.parse(await readFile(config, "utf8")).profiles.b).toBeUndefined();
      await Bun.sleep(300);
      expect(await stat(unused).catch(() => null)).not.toBeNull();
    } finally {
      await rm(packagesLock, { recursive: true, force: true });
    }
    const result = await pending;
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await stat(unused).catch(() => null)).not.toBeNull();
  }, 30_000);

  test("package changes retain previous bundles and another config's locks", async () => {
    const dir = await tempDir();
    const root = join(dir, "cloud", "cld", "plugins");
    const configA = join(dir, "a.json");
    const configB = join(dir, "b.json");
    const lockedDigest = "a".repeat(128);
    const lockedEntry = join(root, "store", lockedDigest);
    await mkdir(lockedEntry, { recursive: true });
    await writeFile(join(lockedEntry, "cli.js"), moduleSource("served"));
    await writeFile(
      configA,
      JSON.stringify({ profiles: { a: { plugins: { served: { app: "served", version: "1", digest: lockedDigest } } } } }),
    );
    const install = await runCli(["plugins", "install", echoBuild, "--yes"], dir, configB);
    expect(install.exitCode, install.stderr).toBe(0);
    const previous = (await readPackagePlugins(root)).echo!;
    // A pre-existing config can lock exactly the bytes of a package plugin.
    await writeFile(
      configA,
      JSON.stringify({
        currentProfile: "a",
        profiles: {
          a: {
            plugins: {
              echo: { app: previous.package, version: previous.version, digest: previous.digest },
            },
          },
        },
      }),
    );
    expect(await Bun.file(join(lockedEntry, "cli.js")).exists()).toBe(true);
    const pkg = await packInlinePlugin(join(dir, "echo-v2"), moduleSource("echo"), "@k2b-test/cld-plugin-echo", "2.0.0");
    const replace = await runCli(["plugins", "install", pkg, "--yes"], dir, configB);
    expect(replace.exitCode, replace.stderr).toBe(0);
    const current = (await readPackagePlugins(root)).echo!;
    expect(current.digest).not.toBe(previous.digest);
    expect((await readdir(join(root, "store"))).sort()).toEqual([lockedDigest, previous.digest, current.digest].sort());
    expect(await hasStoredPlugin(current.digest, root)).toBe(true);
    const remove = await runCli(["plugins", "remove", "echo"], dir, configB);
    expect(remove.exitCode, remove.stderr).toBe(0);
    expect((await readdir(join(root, "store"))).sort()).toEqual([lockedDigest, previous.digest, current.digest].sort());
    const reference = await runCli(["echo", "reference"], dir, configA);
    expect(reference.exitCode, reference.stderr).toBe(0);
    expect(reference.stdout).toContain("Echo");
  });

  test("never runs code before confirmation or conflict checks", async () => {
    const dir = await tempDir();
    const marker = join(dir, "executed");
    const pkg = await packInlinePlugin(
      join(dir, "marker-package"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed"); ${moduleSource("marker")}`,
    );
    await rm(marker); // Packing imports the author's source and output; installing must wait.
    const refused = await runCli(["plugins", "install", pkg], dir);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("pass --yes");
    expect(await Bun.file(marker).exists()).toBe(false);
    const reserved = await packInlinePlugin(join(dir, "reserved"), moduleSource("login"));
    const conflict = await runCli(["plugins", "install", reserved, "--yes"], dir);
    expect(conflict.stderr).toContain('plugin id "login" is reserved by a built-in cld command');
    expect(conflict.stderr).not.toContain("runs inside cld");
    expect((await runCli(["plugins", "install", pkg, "--yes"], dir)).exitCode).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(true);
  }, 30_000);

  test("legacy directories are incompatible, never loaded, warned once and removable", async () => {
    const dir = await tempDir();
    const root = join(dir, "cloud", "cld", "plugins");
    const legacy = join(root, "old");
    await mkdir(legacy, { recursive: true });
    await writeFile(
      join(legacy, "package.json"),
      JSON.stringify({ name: "old-package", version: "1.0.0", cld: { apiVersion: 1, entry: "cli.js" } }),
    );
    await writeFile(join(legacy, "cli.js"), 'throw new Error("legacy code must not run");');
    await mkdir(join(root, "store"));
    await mkdir(join(root, ".locks"));
    await mkdir(join(root, ".ignored"));
    // `locks` was a valid plugin ID in the old format and must stay visible and removable.
    await mkdir(join(root, "locks"));
    expect((await legacyPlugins(root)).map((p) => p.id)).toEqual(["locks", "old"]);
    expect((await runCli(["plugins", "remove", "locks"], dir)).exitCode).toBe(0);
    const list = await runCli(["plugins", "list", "--json"], dir);
    expect(JSON.parse(list.stdout).plugins).toHaveLength(1);
    expect(JSON.parse(list.stdout).plugins[0]).toMatchObject({
      profile: null,
      name: "old",
      status: "incompatible",
      message: expect.stringContaining("old-package@1.0.0 uses the old plugin format"),
    });
    const help = await runCli(["help"], dir);
    expect(help.exitCode).toBe(0);
    expect(help.stderr.trim().split("\n")).toHaveLength(1);
    expect(help.stderr).toContain('plugin "old" skipped (incompatible)');
    expect((await runCli(["old"], dir)).stderr).toContain('Unknown command "old"');
    expect((await runCli(["plugins", "remove", "old"], dir)).exitCode).toBe(0);
    expect(await removePlugin("store", root)).toBe(false);
    expect(await removePlugin(".locks", root)).toBe(false);
    expect((await stat(join(root, ".locks"))).isDirectory()).toBe(true);
    expect(await removePlugin("../old", root)).toBe(false);
  });

  test("reserved records stay reachable through plugins run, while missing store records tell users to reinstall", async () => {
    const dir = await tempDir();
    const root = join(dir, "cloud", "cld", "plugins");
    const pkg = await packInlinePlugin(join(dir, "shadowed"), moduleSource("update"));
    const manifest = await installStaged(pkg, root);
    const help = await runCli(["help"], dir);
    expect(help.stdout).not.toContain("Fake");
    expect((await runCli(["plugins", "run", "update"], dir)).stdout).toBe("ran update\n");
    expect((await runCli(["plugins", "run", "update", "reference"], dir)).stdout).toBe("# test-plugin\n");
    let listed = await runCli(["plugins", "list", "--json"], dir);
    expect(JSON.parse(listed.stdout).plugins[0].status).toBe("shadowed");
    const records = await readPackagePlugins(root);
    records.echo = { ...records.update!, source: echoBuild };
    delete records.update;
    await writePackagePlugins(records, root);
    await rm(join(root, "store", manifest.digest), { recursive: true });
    listed = await runCli(["plugins", "list", "--json"], dir);
    expect(JSON.parse(listed.stdout).plugins[0]).toMatchObject({
      status: "error",
      message: expect.stringContaining(`cld plugins install ${echoBuild}`),
    });
  });
});

test("profile locks win for run, aliases and references; only active package modules get skill rows", async () => {
  const dir = await tempDir();
  const root = join(dir, "cloud", "cld", "plugins");
  const packageDir = await packInlinePlugin(
    join(dir, "package-echo"),
    'export default { name: "echo", summary: "Package echo", requiresCloud: false, run: (ctx) => ctx.print("package echo") };',
    "package-echo",
  );
  expect((await runCli(["plugins", "install", packageDir, "--yes"], dir)).exitCode).toBe(0);
  const packageRecord = (await readPackagePlugins(root)).echo!;
  const servedDir = await packInlinePlugin(
    join(dir, "served-echo"),
    'export default { name: "echo", alias: "e", summary: "Served echo", requiresCloud: false, run: (ctx) => ctx.print("served echo") };',
    "served-echo",
    "2.0.0",
  );
  const staged = await stagePlugin(servedDir);
  const stored = await storePlugin(staged.manifest, (file) => readPackagePluginFile(staged, file), root);
  await placePlugin(stored.incoming, staged.manifest.digest, root);
  await staged.cleanup();
  const lock = { app: "served-echo", version: "2.0.0", digest: staged.manifest.digest, summary: stored.module.summary, alias: "e" };
  const configPath = join(dir, "config.json");
  const target = join(dir, "skills");
  const config = {
    currentProfile: "a",
    profiles: { a: { plugins: { echo: lock }, servedPlugins: ["echo"] }, b: {} },
    skills: { targets: [target] },
  };
  await writeFile(configPath, JSON.stringify(config));
  expect((await runCli(["echo"], dir)).stdout).toBe("served echo\n");
  expect((await runCli(["e"], dir)).stdout).toBe("served echo\n");
  expect((await runCli(["echo", "reference"], dir)).stdout).toBe("# served-echo\n");
  expect((await runCli(["e", "reference"], dir)).stdout).toBe("# served-echo\n");
  expect((await runCli(["--profile", "b", "echo"], dir)).stdout).toBe("package echo\n");
  expect((await runCli(["--profile", "b", "echo", "reference"], dir)).stdout).toBe("# package-echo\n");
  expect((await runCli(["skills", "sync"], dir)).exitCode).toBe(0);
  const skillPath = join(target, "cloud-cli", "SKILL.md");
  let skill = await readFile(skillPath, "utf8");
  expect(skill).toContain("| a | echo | 2.0.0 | Served echo | `references/echo/2.0.0/index.md` |");
  expect(skill.match(/\| \* \| echo \|/g)).toHaveLength(1);
  expect(skill).not.toContain("| b | echo |");
  const allLocked = { ...config, profiles: { a: config.profiles.a, b: { plugins: { echo: lock } } } };
  await writeFile(configPath, JSON.stringify(allLocked));
  expect((await runCli(["skills", "sync"], dir)).exitCode).toBe(0);
  skill = await readFile(skillPath, "utf8");
  expect(skill).toContain("| b | echo | 2.0.0 |");
  expect(skill).not.toContain("| * | echo |");
  expect(await Bun.file(join(target, "cloud-cli", "references", "echo", "1.0.0", "index.md")).exists()).toBe(false);
  // Removing a profile must retain the globally recorded bundle, even while shadowed.
  expect((await runCli(["profile", "rm", "b", "--yes"], dir)).exitCode).toBe(0);
  expect(await hasStoredPlugin(packageRecord.digest, root)).toBe(true);
  // Removing the last served lock reveals the package plugin and syncs its references.
  expect((await runCli(["plugins", "remove", "echo"], dir)).exitCode).toBe(0);
  expect(await readFile(skillPath, "utf8")).toContain("| * | echo | 1.0.0 | Package echo |");
  expect(await hasStoredPlugin(staged.manifest.digest, root)).toBe(true);
  // Removing the package prunes its skill row and reference folder, retaining shared bytes.
  expect((await runCli(["plugins", "remove", "echo"], dir)).exitCode).toBe(0);
  expect(await readFile(skillPath, "utf8")).not.toContain("| * | echo |");
  expect(await Bun.file(join(target, "cloud-cli", "references", "echo", "1.0.0", "index.md")).exists()).toBe(false);
  expect(await hasStoredPlugin(packageRecord.digest, root)).toBe(true);
}, 30_000);

test("local npm-layout tarballs use the shared store and keep nested skill references", async () => {
  const dir = await tempDir();
  await cp(echoBuild, join(dir, "package"), { recursive: true });
  const archive = join(dir, "echo.tgz");
  expect(Bun.spawnSync(["tar", "-czf", archive, "-C", dir, "package"]).exitCode).toBe(0);
  const target = join(dir, "skills");
  expect((await runCli(["skills", "add", target], dir)).exitCode).toBe(0);
  const installed = await runCli(["plugins", "install", archive, "--yes", "--json"], dir);
  expect(installed.exitCode, installed.stderr).toBe(0);
  expect(JSON.parse(installed.stdout)).toMatchObject({ source: archive, references: 2 });
  const root = join(dir, "cloud", "cld", "plugins");
  expect(await hasStoredPlugin((await readPackagePlugins(root)).echo!.digest, root)).toBe(true);
  expect((await runCli(["echo", "reference", "guides/setup.md"], dir)).stdout).toContain("# Echo setup");
  expect(await readFile(join(target, "cloud-cli", "references", "echo", "1.0.0", "guides", "setup.md"), "utf8")).toContain("# Echo setup");
});

test("nested bundle roots ignore foreign files outside them and reinstall repairs a missing store entry", async () => {
  const dir = await tempDir();
  const pkg = join(dir, "package");
  await cp(echoBuild, join(pkg, "bundle"), { recursive: true });
  const raw = await Bun.file(join(echoBuild, "package.json")).json();
  await writeFile(join(pkg, "package.json"), JSON.stringify({ ...raw, cld: { manifest: "bundle/manifest.json" } }));
  await writeFile(join(pkg, "ignored.txt"), "ignored");
  await symlink("ignored.txt", join(pkg, "outside-link"));
  const result = await runCli(["plugins", "install", pkg, "--yes"], dir);
  expect(result.exitCode, result.stderr).toBe(0);
  const root = join(dir, "cloud", "cld", "plugins");
  const record = (await readPackagePlugins(root)).echo!;
  const stored = join(root, "store", record.digest);
  expect((await readdir(stored)).sort()).toEqual(["cli.js", "manifest.json", "references"]);
  await rm(join(stored, "cli.js"));
  expect(JSON.parse((await runCli(["plugins", "list", "--json"], dir)).stdout).plugins[0].status).toBe("error");
  expect((await runCli(["plugins", "install", pkg, "--yes"], dir)).exitCode).toBe(0);
  expect(await hasStoredPlugin(record.digest, root)).toBe(true);
  expect((await runCli(["echo", "reference"], dir)).stdout).toContain("# Echo package");
  // An escaping symlink in the manifest path itself must be rejected.
  await writeFile(join(pkg, "package.json"), JSON.stringify({ ...raw, cld: { manifest: "bundle-link/manifest.json" } }));
  await symlink("bundle", join(pkg, "bundle-link"));
  await expectPluginError(stagePlugin(pkg), "error", "symlink");
});

test("reinstalling a package repairs missing manifests and missing or truncated references", async () => {
  const dir = await tempDir();
  const root = join(dir, "cloud", "cld", "plugins");
  expect((await runCli(["plugins", "install", echoBuild, "--yes"], dir)).exitCode).toBe(0);
  const record = (await readPackagePlugins(root)).echo!;
  const stored = join(root, "store", record.digest);
  const reference = join(stored, "references", "index.md");
  const expected = await readFile(reference, "utf8");
  const mutations = [() => rm(join(stored, "manifest.json")), () => rm(reference), () => writeFile(reference, "# Echo")];
  for (const mutate of mutations) {
    await mutate();
    expect(await hasStoredPlugin(record.digest, root)).toBe(false);
    const listed = await runCli(["plugins", "list", "--json"], dir);
    expect(JSON.parse(listed.stdout).plugins[0].status).toBe("error");
    const reinstall = await runCli(["plugins", "install", echoBuild, "--yes"], dir);
    expect(reinstall.exitCode, reinstall.stderr).toBe(0);
    expect(await hasStoredPlugin(record.digest, root)).toBe(true);
    expect(await readFile(reference, "utf8")).toBe(expected);
    const printed = await runCli(["echo", "reference"], dir);
    expect(printed.exitCode, printed.stderr).toBe(0);
    expect(printed.stdout).toBe(expected);
  }
  // A same-size change keeps the entry complete, but a reinstall still restores the verified bytes.
  await writeFile(reference, "x".repeat(Buffer.byteLength(expected)));
  expect(await hasStoredPlugin(record.digest, root)).toBe(true);
  expect(await hasStoredPlugin(record.digest, root, true)).toBe(false);
  const reinstall = await runCli(["plugins", "install", echoBuild, "--yes"], dir);
  expect(reinstall.exitCode, reinstall.stderr).toBe(0);
  expect(await readFile(reference, "utf8")).toBe(expected);
});

test("package names never resolve inherited object properties as profile locks", async () => {
  const dir = await tempDir();
  const pkg = await packInlinePlugin(join(dir, "constructor"), moduleSource("constructor"));
  const install = await runCli(["plugins", "install", pkg, "--yes"], dir);
  expect(install.exitCode, install.stderr).toBe(0);
  expect((await runCli(["constructor"], dir)).stdout).toBe("ran constructor\n");
  expect((await runCli(["plugins", "update", "constructor"], dir)).stderr).toContain(`cld plugins install ${pkg}`);
  expect((await runCli(["plugins", "remove", "constructor"], dir)).exitCode).toBe(0);
  expect(await readPackagePlugins(join(dir, "cloud", "cld", "plugins"))).toEqual({});
});
