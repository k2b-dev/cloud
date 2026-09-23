import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEchoPlugin } from "../test/fixtures/build-plugin";
import {
  commitPlugin,
  loadPlugin,
  loadPlugins,
  PluginError,
  readPluginManifest,
  removePlugin,
  stagePlugin,
  validatePluginModule,
} from "./plugins";

const workspace = await mkdtemp(join(tmpdir(), "cld-plugins-test-"));
const echoBuild = await buildEchoPlugin(join(workspace, "echo-build"));
let counter = 0;
const tempDir = async (): Promise<string> => {
  counter += 1;
  const dir = join(workspace, `case-${counter}`);
  await mkdir(dir, { recursive: true });
  return dir;
};

afterAll(() => rm(workspace, { recursive: true, force: true }));

const writePlugin = async (directory: string, cld: unknown, entrySource = "export default {}"): Promise<void> => {
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "fake", version: "0.1.0", cld }));
  await writeFile(join(directory, "dist", "cli.js"), entrySource);
};

const moduleSource = (name: string) =>
  `export default { name: ${JSON.stringify(name)}, summary: "Fake", requiresCloud: false, run: (ctx) => { ctx.print("ran ${name}"); } };`;

const expectPluginError = async (promise: Promise<unknown>, status: PluginError["status"], message: string | RegExp) => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof PluginError)) throw new Error(`expected a PluginError, got ${String(error)}`);
  expect(error.status).toBe(status);
  expect(error.message).toMatch(message);
};

describe("plugin manifest", () => {
  test("reads package name, version, and an entry inside the package", async () => {
    const manifest = await readPluginManifest(echoBuild);
    expect(manifest).toEqual({ package: "@k2b-test/cld-plugin-echo", version: "1.0.0", entry: join(echoBuild, "dist", "cli.js") });
  });

  test("rejects an incompatible API version with a distinct status", async () => {
    const dir = await tempDir();
    await writePlugin(dir, { apiVersion: 2, entry: "dist/cli.js" });
    await expectPluginError(readPluginManifest(dir), "incompatible", "needs plugin API 2; this cld supports 1");
  });

  test("rejects a missing manifest, an escaping entry, and a missing entry file", async () => {
    const dir = await tempDir();
    await writePlugin(dir, undefined);
    await expectPluginError(readPluginManifest(dir), "error", 'no "cld" manifest');
    await writePlugin(dir, { apiVersion: 1, entry: "../outside.js" });
    await expectPluginError(readPluginManifest(dir), "error", "inside the plugin directory");
    await writePlugin(dir, { apiVersion: 1, entry: "dist/missing.js" });
    await expectPluginError(readPluginManifest(dir), "error", "does not exist");
  });

  test("validates the module structurally, independent of the package copy", () => {
    const plain = { name: "inventory", summary: "Inventory", run: () => 0 };
    expect(validatePluginModule(plain)).toBe(plain);
    expect(() => validatePluginModule(undefined)).toThrow("not a CLI module");
    expect(() => validatePluginModule({ ...plain, name: "Inventory" })).toThrow("kebab-case");
    expect(() => validatePluginModule({ ...plain, run: undefined })).toThrow("run function");
    expect(() => validatePluginModule({ ...plain, booleanFlags: [1] })).toThrow("booleanFlags");
  });
});

describe("plugin loading", () => {
  test("loads good plugins and isolates shadowed, incompatible, broken, and mismatched ones", async () => {
    const root = await tempDir();
    await buildEchoPlugin(join(root, "echo"));
    await writePlugin(join(root, "profile"), { apiVersion: 1, entry: "dist/cli.js" }, moduleSource("profile"));
    await writePlugin(join(root, "future"), { apiVersion: 2, entry: "dist/cli.js" }, moduleSource("future"));
    await writePlugin(join(root, "broken"), { apiVersion: 1, entry: "dist/cli.js" }, 'throw new Error("boom");');
    await writePlugin(join(root, "renamed"), { apiVersion: 1, entry: "dist/cli.js" }, moduleSource("other"));
    await mkdir(join(root, ".incoming-echo-1"));

    const { modules, plugins } = await loadPlugins(new Set(["profile"]), root);

    expect(modules.map((module) => module.name)).toEqual(["echo"]);
    expect(plugins.map(({ id, status }) => [id, status])).toEqual([
      ["broken", "error"],
      ["echo", "ok"],
      ["future", "incompatible"],
      ["profile", "shadowed"],
      ["renamed", "error"],
    ]);
    expect(plugins.find((plugin) => plugin.id === "broken")?.message).toContain("boom");
    expect(plugins.find((plugin) => plugin.id === "profile")?.message).toBe(
      "shadowed by a built-in command, use `cld plugins run profile`",
    );
    expect(plugins.find((plugin) => plugin.id === "renamed")?.message).toContain('"other" does not match its directory "renamed"');
    expect(plugins.find((plugin) => plugin.id === "echo")).toMatchObject({
      package: "@k2b-test/cld-plugin-echo",
      version: "1.0.0",
      source: "manual",
    });
  });

  test("loads one plugin by id and ignores unknown or invalid ids", async () => {
    const root = await tempDir();
    await buildEchoPlugin(join(root, "echo"));
    expect((await loadPlugin("echo", root))?.name).toBe("echo");
    expect(await loadPlugin("missing", root)).toBeUndefined();
    expect(await loadPlugin("../echo", root)).toBeUndefined();
  });
});

describe("plugin install and remove", () => {
  test("installs from a directory, records the source, replaces, and removes", async () => {
    const root = await tempDir();
    const staged = await stagePlugin(echoBuild);
    try {
      expect(staged.source).toBe(echoBuild);
      expect(await commitPlugin(staged, new Set(), root)).toEqual({ id: "echo", replaced: false });
      expect(await commitPlugin(staged, new Set(), root)).toEqual({ id: "echo", replaced: true });
    } finally {
      await staged.cleanup();
    }
    const { plugins } = await loadPlugins(new Set(), root);
    expect(plugins).toEqual([{ id: "echo", package: "@k2b-test/cld-plugin-echo", version: "1.0.0", source: echoBuild, status: "ok" }]);
    expect(await removePlugin("echo", root)).toBe(true);
    expect(await removePlugin("echo", root)).toBe(false);
    expect((await loadPlugins(new Set(), root)).plugins).toEqual([]);
  });

  test("refuses a plugin whose name belongs to a built-in command", async () => {
    const root = await tempDir();
    const staged = await stagePlugin(echoBuild);
    try {
      await expectPluginError(
        commitPlugin(staged, new Set(["echo"]), root),
        "shadowed",
        'plugin id "echo" is reserved by a built-in cld command',
      );
    } finally {
      await staged.cleanup();
    }
  });

  test("installs a verified npm tarball and rejects an integrity mismatch", async () => {
    const dir = await tempDir();
    const packageDir = join(dir, "package");
    await buildEchoPlugin(packageDir);
    const archive = join(dir, "echo.tgz");
    expect(Bun.spawnSync(["tar", "-czf", archive, "-C", dir, "package"]).exitCode).toBe(0);
    const bytes = await readFile(archive);
    let integrity = `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;
    const registry: ReturnType<typeof Bun.serve> = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request): Response {
        const path = new URL(request.url).pathname;
        if (path === "/@k2b-test%2fcld-plugin-echo/latest") {
          return Response.json({ version: "1.0.0", dist: { tarball: `${registry.url.origin}/echo.tgz`, integrity } });
        }
        if (path === "/echo.tgz") return new Response(bytes);
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const root = await tempDir();
      const staged = await stagePlugin("@k2b-test/cld-plugin-echo", { registry: registry.url.origin });
      try {
        expect(staged.source).toBe("npm:@k2b-test/cld-plugin-echo@1.0.0");
        expect(await commitPlugin(staged, new Set(), root)).toEqual({ id: "echo", replaced: false });
      } finally {
        await staged.cleanup();
      }
      expect((await loadPlugins(new Set(), root)).plugins[0]).toMatchObject({ id: "echo", status: "ok" });

      integrity = `sha512-${Buffer.from("wrong").toString("base64")}`;
      await expectPluginError(stagePlugin("@k2b-test/cld-plugin-echo", { registry: registry.url.origin }), "error", "integrity mismatch");
      await expectPluginError(stagePlugin("@k2b-test/missing@2.0.0", { registry: registry.url.origin }), "error", "returned 404");
      await expectPluginError(stagePlugin("Not A Package"), "error", "neither a local path nor an npm package");
    } finally {
      await registry.stop(true);
    }
  });
});

describe("cld plugins command", () => {
  const runCli = async (args: string[], configHome: string) => {
    const child = Bun.spawn([process.execPath, "run", "packages/cloud-cli/src/index.ts", ...args], {
      cwd: join(import.meta.dir, "../../.."),
      env: { ...process.env, XDG_CONFIG_HOME: configHome, CLD_CONFIG: join(configHome, "config.json") },
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

  test("installs, runs with the host context, lists, and removes a plugin while built-ins keep working", async () => {
    const configHome = await tempDir();
    const pluginsRoot = join(configHome, "cloud", "cld", "plugins");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        Response.json({ authorization: request.headers.get("authorization"), locale: request.headers.get("accept-language") }),
    });
    try {
      const refused = await runCli(["plugins", "install", echoBuild], configHome);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("pass --yes");

      const installed = await runCli(["plugins", "install", echoBuild, "--yes"], configHome);
      expect(installed.exitCode, installed.stderr).toBe(0);
      expect(installed.stderr).toContain(`@k2b-test/cld-plugin-echo@1.0.0 from ${echoBuild} runs inside cld with your Cloud credentials`);
      expect(installed.stdout).toContain('Installed plugin "echo"');

      const ran = await runCli(
        ["--server", server.url.origin, "--token", "plugin-token", "--locale", "de", "--json", "echo", "whoami"],
        configHome,
      );
      expect(ran.exitCode, ran.stderr).toBe(0);
      expect(JSON.parse(ran.stdout)).toEqual({ authorization: "Bearer plugin-token", locale: "de", profile: "default", output: "json" });

      await writePlugin(join(pluginsRoot, "broken"), { apiVersion: 1, entry: "dist/cli.js" }, 'throw new Error("boom");');
      await writePlugin(join(pluginsRoot, "update"), { apiVersion: 1, entry: "dist/cli.js" }, moduleSource("update"));
      const help = await runCli(["help"], configHome);
      expect(help.exitCode, help.stderr).toBe(0);
      expect(help.stdout).toMatch(/\n {2}echo +Echo the host CLI context/);
      expect(help.stderr).toContain('plugin "broken" skipped (error)');
      expect(help.stderr).toContain('plugin "update" shadowed by a built-in command, use `cld plugins run update`');
      const germanHelp = await runCli(["--locale", "de", "help"], configHome);
      expect(germanHelp.stderr).toContain('Plugin "update" verdeckt durch eingebauten Befehl, nutze `cld plugins run update`');

      const shadowedRun = await runCli(["plugins", "run", "update", "anything"], configHome);
      expect(shadowedRun.exitCode, shadowedRun.stderr).toBe(0);
      expect(shadowedRun.stdout).toBe("ran update\n");
      const flatRun = await runCli(
        ["--server", server.url.origin, "--token", "plugin-token", "plugins", "run", "echo", "whoami", "--json"],
        configHome,
      );
      expect(flatRun.exitCode, flatRun.stderr).toBe(0);
      expect(JSON.parse(flatRun.stdout)).toMatchObject({ authorization: "Bearer plugin-token", output: "json" });
      const missingRun = await runCli(["plugins", "run", "missing"], configHome);
      expect(missingRun.exitCode).toBe(1);
      expect(missingRun.stderr).toContain('Plugin "missing" is not installed.');

      const pluginsHelp = await runCli(["plugins", "help"], configHome);
      expect(pluginsHelp.stdout).toContain("cld plugins run <id> [args...]");

      const reservedSource = join(configHome, "reserved-plugin");
      await writePlugin(reservedSource, { apiVersion: 1, entry: "dist/cli.js" }, moduleSource("grids"));
      const reserved = await runCli(["plugins", "install", reservedSource, "--yes"], configHome);
      expect(reserved.exitCode).toBe(1);
      expect(reserved.stderr).toContain('Cannot install plugin: plugin id "grids" is reserved by a built-in cld command');

      const builtIn = await runCli(
        ["--server", "https://cloud.invalid", "--token", "t", "--json", "grids", "workflows", "reference"],
        configHome,
      );
      expect(builtIn.exitCode, builtIn.stderr).toBe(0);
      expect(builtIn.stderr).toBe("");

      const broken = await runCli(["broken", "anything"], configHome);
      expect(broken.exitCode).toBe(1);
      expect(broken.stderr).toContain('Plugin "broken" cannot run: cannot load entry');

      const listed = await runCli(["plugins", "list", "--json"], configHome);
      expect(listed.exitCode, listed.stderr).toBe(0);
      expect(JSON.parse(listed.stdout).plugins.map((plugin: { id: string; status: string }) => `${plugin.id}:${plugin.status}`)).toEqual([
        "broken:error",
        "echo:ok",
        "update:shadowed",
      ]);

      const removed = await runCli(["plugins", "remove", "echo"], configHome);
      expect(removed.exitCode, removed.stderr).toBe(0);
      const gone = await runCli(["echo", "whoami"], configHome);
      expect(gone.exitCode).toBe(1);
      expect(gone.stderr).toContain('Unknown module "echo"');
    } finally {
      await server.stop(true);
    }
  }, 30_000);
});
