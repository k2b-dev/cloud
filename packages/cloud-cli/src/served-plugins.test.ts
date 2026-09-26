import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEchoPlugin } from "../test/fixtures/build-plugin";
import { type PluginCloudState, servedEchoPlugin, startPluginCloud } from "../test/fixtures/plugin-cloud";

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const setup = async (profiles: Record<string, PluginCloudState>) => {
  const dir = await mkdtemp(join(tmpdir(), "cld-served-plugins-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const servers = Object.fromEntries(
    Object.entries(profiles).map(([name, state]) => {
      const server = startPluginCloud(state);
      cleanup.push(() => server.stop(true));
      return [name, server];
    }),
  );
  const configPath = join(dir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      currentProfile: Object.keys(profiles)[0],
      profiles: Object.fromEntries(
        Object.entries(servers).map(([name, server]) => [name, { server: server.url.origin, token: `token-${name}` }]),
      ),
    }),
  );
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "index.ts"), ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: dir, XDG_CONFIG_HOME: dir, CLD_CONFIG: configPath },
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
  const store = join(dir, "cloud", "cld", "plugins", "store");
  const stored = async () => (await readdir(store).catch(() => [] as string[])).filter((name) => !name.startsWith(".")).sort();
  const config = async () => JSON.parse(await readFile(configPath, "utf8"));
  return { dir, run, stored, config };
};

test("profiles lock their own verified plugin versions and share identical ones", async () => {
  const [v1, v2] = [await servedEchoPlugin("1.0.0"), await servedEchoPlugin("2.0.0")];
  const clouds = { a: { plugins: [v1], authorizations: [] }, b: { plugins: [v2], authorizations: [] } } satisfies Record<
    string,
    PluginCloudState
  >;
  const cli = await setup(clouds);

  const hint = await cli.run(["echo", "whoami"]);
  expect(hint.exitCode).toBe(1);
  expect(hint.stderr).toContain("run `cld plugins install echo`");

  const listed = await cli.run(["plugins", "list", "--json"]);
  expect(listed.exitCode, listed.stderr).toBe(0);
  expect(JSON.parse(listed.stdout).plugins).toEqual([
    { profile: "a", name: "echo", app: "echo-app", installed: null, available: "1.0.0", status: "available", source: "cloud" },
  ]);

  const installed = await cli.run(["plugins", "install", "echo"]);
  expect(installed.exitCode, installed.stderr).toBe(0);
  expect(installed.stdout).toContain('Installed echo 1.0.0 (profile "a")');
  expect((await cli.run(["--profile", "b", "plugins", "install", "--all", "--json"])).exitCode).toBe(0);
  expect(await cli.stored()).toEqual([v1.manifest.digest, v2.manifest.digest].sort());
  expect((await cli.config()).profiles.a.plugins).toEqual({
    echo: { app: "echo-app", version: "1.0.0", digest: v1.manifest.digest, summary: "Echo the host CLI context (test plugin)." },
  });

  // Each profile runs its own version against its own Cloud with its own token.
  for (const profile of ["a", "b"] as const) {
    const echoed = await cli.run(["--profile", profile, "--json", "echo", "whoami"]);
    expect(echoed.exitCode, echoed.stderr).toBe(0);
    expect(JSON.parse(echoed.stdout)).toMatchObject({ authorization: `Bearer token-${profile}`, profile });
  }
  expect((await cli.run(["help"])).stdout).toContain("echo         Echo the host CLI context (test plugin).");

  // The plugin's skill references come with it.
  const reference = await cli.run(["echo", "reference"]);
  expect(reference.exitCode, reference.stderr).toBe(0);
  expect(reference.stdout).toBe("# Echo 1.0.0\n");
  expect((await cli.run(["echo", "reference", "index.md"])).stdout).toBe("# Echo 1.0.0\n");
  const missingReference = await cli.run(["echo", "reference", "missing.md"]);
  expect(missingReference.exitCode).toBe(1);
  expect(missingReference.stderr).toContain('no reference "missing.md". Available: index.md');

  // The agent skill: one folder per target with the core skill, a table of every profile's modules, and the references per version.
  const skills = join(cli.dir, "agent-skills");
  const added = await cli.run(["skills", "add", skills]);
  expect(added.exitCode, added.stderr).toBe(0);
  expect((await cli.config()).skills).toEqual({ targets: ["~/agent-skills"] });
  const skill = await readFile(join(skills, "cloud-cli", "SKILL.md"), "utf8");
  expect(skill).toContain("| a | echo | 1.0.0 | `references/echo/1.0.0/` |");
  expect(skill).toContain("| b | echo | 2.0.0 | `references/echo/2.0.0/` |");
  expect(skill).toContain("cld <app> reference");
  expect(await readFile(join(skills, "cloud-cli", "references", "echo", "1.0.0", "index.md"), "utf8")).toBe("# Echo 1.0.0\n");
  expect(await readFile(join(skills, "cloud-cli", "references", "echo", "2.0.0", "index.md"), "utf8")).toBe("# Echo 2.0.0\n");
  expect((await readdir(join(skills, "cloud-cli", "references"))).sort()).toEqual(["echo", "plugins.md", "sign-in.md"]);
  expect((await cli.run(["skills", "list"])).stdout.trim()).toBe(join(skills, "cloud-cli"));

  // Cloud A moves to v2: list shows the update, update installs it, and the
  // now unused v1 leaves the store because both profiles use the same v2.
  clouds.a.plugins = [v2];
  const outdated = await cli.run(["plugins", "list", "--all", "--json"]);
  expect(JSON.parse(outdated.stdout).plugins.map((row: { status: string }) => row.status)).toEqual(["update available", "ok"]);
  const updated = await cli.run(["plugins", "update"]);
  expect(updated.exitCode, updated.stderr).toBe(0);
  expect(updated.stdout).toContain('Updated echo 1.0.0 → 2.0.0 (profile "a")');
  expect(await cli.stored()).toEqual([v2.manifest.digest]);
  // The skill followed: both profiles use 2.0.0, and the 1.0.0 folder is gone.
  expect(await readFile(join(skills, "cloud-cli", "SKILL.md"), "utf8")).toContain("| a | echo | 2.0.0 |");
  expect(await readdir(join(skills, "cloud-cli", "references", "echo"))).toEqual(["2.0.0"]);
  expect((await cli.run(["plugins", "update", "--all"])).stdout).toContain('echo 2.0.0 is up to date (profile "b")');

  const removed = await cli.run(["plugins", "remove", "echo"]);
  expect(removed.exitCode, removed.stderr).toBe(0);
  expect((await cli.config()).profiles.a.plugins).toEqual({});
  expect(await cli.stored()).toEqual([v2.manifest.digest]);
  expect((await cli.run(["--profile", "b", "plugins", "remove", "echo"])).exitCode).toBe(0);
  expect(await cli.stored()).toEqual([]);
  expect(await readFile(join(skills, "cloud-cli", "SKILL.md"), "utf8")).toContain("No module is installed for any profile yet");
  expect((await cli.run(["skills", "remove", skills])).exitCode).toBe(0);
  expect(await readdir(skills)).toEqual([]);
  expect((await cli.config()).skills).toEqual({ targets: [] });
  const noTarget = await cli.run(["skills", "sync"]);
  expect(noTarget.exitCode).toBe(1);
  expect(noTarget.stderr).toContain("No skill target configured");
}, 30_000);

test("a file that does not match the manifest leaves the store and the lock untouched", async () => {
  const plugin = await servedEchoPlugin("1.0.0");
  const cloud: PluginCloudState = {
    plugins: [plugin],
    authorizations: [],
    tampered: new Map([["cli.js", new Uint8Array(plugin.files.get("cli.js")!).fill(32)]]),
  };
  const cli = await setup({ a: cloud });
  const result = await cli.run(["plugins", "install", "echo"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("echo/cli.js does not match its SHA-512");
  expect(await cli.stored()).toEqual([]);
  expect((await cli.config()).profiles.a.plugins).toBeUndefined();

  cloud.tampered = new Map([["references/index.md", new TextEncoder().encode("# Echo 1.0.0\nmore\n")]]);
  expect((await cli.run(["plugins", "install", "echo"])).stderr).toContain("larger than its manifest says");
  expect(await cli.stored()).toEqual([]);
});

test("plugin access errors, reserved names, and package plugins stay distinct", async () => {
  const plugin = await servedEchoPlugin("1.0.0");
  const cloud: PluginCloudState = { plugins: [plugin], authorizations: [], status: 403 };
  const cli = await setup({ a: cloud });

  const denied = await cli.run(["plugins", "install", "--all"]);
  expect(denied.exitCode).toBe(1);
  expect(denied.stderr).toContain("does not offer CLI plugins to your account (403)");

  const reserved = await cli.run(["plugins", "install", "login"]);
  expect(reserved.exitCode).toBe(1);
  expect(reserved.stderr).toContain('"login" is a built-in cld command');

  const notAName = await cli.run(["plugins", "install", "Echo@1"]);
  expect(notAName.stderr).toContain("npm:<package>");

  // A package plugin installed for every profile blocks the Cloud's plugin of the same name, and vice versa.
  cloud.status = undefined;
  const local = await buildEchoPlugin(join(cli.dir, "echo-package"));
  expect((await cli.run(["plugins", "install", local, "--yes"])).exitCode).toBe(0);
  const clash = await cli.run(["plugins", "install", "echo"]);
  expect(clash.exitCode).toBe(1);
  expect(clash.stderr).toContain('a package plugin "echo" is installed for every profile');
  expect((await cli.run(["plugins", "remove", "echo"])).exitCode).toBe(0);
  expect((await cli.run(["plugins", "install", "echo"])).exitCode).toBe(0);
  const reverse = await cli.run(["plugins", "install", local, "--yes"]);
  expect(reverse.exitCode).toBe(1);
  expect(reverse.stderr).toContain(`profile "a" already uses the Cloud's plugin "echo"`);
});

test("login offers the Cloud's plugins and installs them with --yes", async () => {
  const cloud: PluginCloudState = { plugins: [await servedEchoPlugin("1.0.0")], authorizations: [] };
  const cli = await setup({ a: cloud });
  const origin = (await cli.config()).profiles.a.server as string;
  const child = Bun.spawn(
    [process.execPath, "run", join(import.meta.dir, "index.ts"), "login", "a", "--server", origin, "--no-open", "--yes"],
    {
      env: { PATH: process.env.PATH ?? "", HOME: cli.dir, XDG_CONFIG_HOME: cli.dir, CLD_CONFIG: join(cli.dir, "config.json") },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const reader = child.stdout.getReader();
  let stdout = "";
  while (!stdout.includes("Waiting for the OAuth callback.")) {
    const { done, value } = await reader.read();
    if (done) break;
    stdout += new TextDecoder().decode(value);
  }
  const loginUrl = new URL(stdout.match(/(http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\S+)/)![1]!);
  const callback = new URL(loginUrl.searchParams.get("redirect_uri")!);
  callback.searchParams.set("code", "test-code");
  callback.searchParams.set("state", loginUrl.searchParams.get("state")!);
  callback.searchParams.set("iss", origin);
  expect((await fetch(callback)).status).toBe(200);
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) stdout += new TextDecoder().decode(chunk.value);
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  expect(stdout).toContain('Installed echo 1.0.0 (profile "a")');
  expect(stdout).toContain(`Wrote the cloud-cli skill to ${join(cli.dir, ".agents", "skills", "cloud-cli")}.`);
  expect(cloud.authorizations).toContain("Bearer login-access");
  expect(Object.keys((await cli.config()).profiles.a.plugins)).toEqual(["echo"]);
  expect((await cli.config()).skills).toEqual({ targets: ["~/.agents/skills"] });
  expect(await readFile(join(cli.dir, ".agents", "skills", "cloud-cli", "SKILL.md"), "utf8")).toContain("| a | echo | 1.0.0 |");
});
