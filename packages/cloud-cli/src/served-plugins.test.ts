import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEchoPlugin, packInlinePlugin } from "../test/fixtures/build-plugin";
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
  const run = async (args: string[], extraPath?: string) => {
    const child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "index.ts"), ...args], {
      env: { PATH: [extraPath, process.env.PATH ?? ""].filter(Boolean).join(":"), HOME: dir, XDG_CONFIG_HOME: dir, CLD_CONFIG: configPath },
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
    {
      profile: "a",
      name: "echo",
      app: "echo-app",
      installed: null,
      available: "1.0.0",
      status: "available",
      source: "cloud",
      alias: null,
      shortcuts: {},
      inactive: [],
    },
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
  expect(skill).toContain("| a | echo | 1.0.0 | Echo the host CLI context (test plugin). | `references/echo/1.0.0/index.md` |");
  expect(skill).toContain("| b | echo | 2.0.0 | Echo the host CLI context (test plugin). | `references/echo/2.0.0/index.md` |");
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

test("a release that ships the same bundle under a new version refreshes the version label", async () => {
  const v1 = await servedEchoPlugin("1.0.0");
  const cloud: PluginCloudState = { plugins: [v1], authorizations: [] };
  const cli = await setup({ a: cloud });
  expect((await cli.run(["plugins", "install", "echo"])).exitCode).toBe(0);
  const skills = join(cli.dir, "agent-skills");
  expect((await cli.run(["skills", "add", skills])).exitCode).toBe(0);
  const installedConfig = await readFile(join(cli.dir, "config.json"), "utf8");
  cloud.plugins = [{ ...v1, manifest: { ...v1.manifest, version: "1.1.0" } }];

  const before = await cli.run(["plugins", "list", "--json"]);
  expect(before.exitCode, before.stderr).toBe(0);
  expect(JSON.parse(before.stdout).plugins[0]).toMatchObject({ installed: "1.0.0", available: "1.1.0", status: "update available" });
  expect(await cli.run(["plugins", "update"])).toEqual({
    exitCode: 0,
    stdout: 'Updated echo 1.0.0 → 1.1.0 (profile "a"): version label refreshed, files unchanged.\n',
    stderr: "",
  });
  expect((await cli.config()).profiles.a.plugins.echo).toMatchObject({ version: "1.1.0", digest: v1.manifest.digest });
  const after = await cli.run(["plugins", "list", "--json"]);
  expect(after.exitCode, after.stderr).toBe(0);
  expect(JSON.parse(after.stdout).plugins[0]).toMatchObject({ installed: "1.1.0", available: "1.1.0", status: "ok" });
  expect(await readFile(join(skills, "cloud-cli", "SKILL.md"), "utf8")).toContain(
    "| a | echo | 1.1.0 | Echo the host CLI context (test plugin). | `references/echo/1.1.0/index.md` |",
  );
  expect(await readdir(join(skills, "cloud-cli", "references", "echo"))).toEqual(["1.1.0"]);
  expect(await readFile(join(skills, "cloud-cli", "references", "echo", "1.1.0", "index.md"), "utf8")).toBe("# Echo 1.0.0\n");
  expect(await cli.stored()).toEqual([v1.manifest.digest]);
  expect((await cli.run(["plugins", "update"])).stdout).toBe('echo 1.1.0 is up to date (profile "a").\n');

  await writeFile(join(cli.dir, "config.json"), installedConfig);
  const json = await cli.run(["plugins", "update", "--json"]);
  expect(json.exitCode, json.stderr).toBe(0);
  expect(JSON.parse(json.stdout).plugins).toEqual([
    {
      profile: "a",
      name: "echo",
      app: "echo-app",
      version: "1.1.0",
      previous: "1.0.0",
      status: "updated",
      message: "version label refreshed; files unchanged",
    },
  ]);
  await writeFile(join(cli.dir, "config.json"), installedConfig);
  expect(await cli.run(["--locale", "de", "plugins", "update"])).toEqual({
    exitCode: 0,
    stdout: 'echo 1.0.0 → 1.1.0 aktualisiert (Profil "a"): nur die Versionsangabe, Dateien unverändert.\n',
    stderr: "",
  });
}, 30_000);

test("update --all continues past a profile whose token cannot be read", async () => {
  const v1 = await servedEchoPlugin("1.0.0");
  const v2 = await servedEchoPlugin("2.0.0");
  const clouds: Record<string, PluginCloudState> = Object.fromEntries(
    ["a", "b", "c"].map((name) => [name, { plugins: [v1], authorizations: [] }]),
  );
  const cli = await setup(clouds);
  for (const profile of ["a", "b", "c"]) {
    const installed = await cli.run(["--profile", profile, "plugins", "install", "echo"]);
    expect(installed.exitCode, installed.stderr).toBe(0);
    clouds[profile]!.plugins = [v2];
  }
  const bin = join(cli.dir, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "fd0"),
    `#!/bin/sh
case "$2" in
  b-oauth-client-secret) printf '\nfd0 agent is locked\nmore detail\n' >&2; exit 1 ;;
  c-token) printf 'token-c-SECRET' ;;
esac
`,
  );
  await chmod(join(bin, "fd0"), 0o700);
  const config = await cli.config();
  delete config.profiles.b.token;
  config.profiles.b.fd0 = { name: "b-oauth-client-secret" };
  delete config.profiles.c.token;
  config.profiles.c.fd0 = { name: "c-token" };
  const configPath = join(cli.dir, "config.json");
  const reason = 'Cannot read the token from fd0 item "b-oauth-client-secret": fd0 agent is locked';
  const failure = { profile: "b", status: "failed", message: reason };
  for (const output of [undefined, "--json", "--jsonl"]) {
    await writeFile(configPath, JSON.stringify(config));
    const result = await cli.run(["--profile", "a", "plugins", "update", "--all", ...(output ? [output] : [])], bin);
    expect(result.exitCode).toBe(1);
    if (output === "--json") expect(JSON.parse(result.stdout).plugins).toContainEqual(failure);
    else if (output === "--jsonl")
      expect(
        result.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toContainEqual(failure);
    else {
      expect(result.stdout).toContain('Updated echo 1.0.0 → 2.0.0 (profile "a").');
      expect(result.stdout).toContain('Updated echo 1.0.0 → 2.0.0 (profile "c").');
      expect(result.stderr).toBe(`cld: b: ${reason}\n`);
    }
    expect(result.stdout + result.stderr).not.toContain("token-c-SECRET");
    const locked = (await cli.config()).profiles;
    expect(locked.a.plugins.echo.version).toBe("2.0.0");
    expect(locked.b.plugins.echo.version).toBe("1.0.0");
    expect(locked.c.plugins.echo.version).toBe("2.0.0");
  }
  expect(await cli.run(["--profile", "b", "plugins", "update"], bin)).toEqual({ exitCode: 1, stdout: "", stderr: `${reason}\n` });
  const german = await cli.run(["--locale", "de", "plugins", "update", "--all"], bin);
  expect(german.exitCode).toBe(1);
  expect(german.stderr).toBe('cld: b: Token aus fd0-Eintrag "b-oauth-client-secret" kann nicht gelesen werden: fd0 agent is locked\n');
}, 30_000);

test("token command failures omit the command text and its stdout", async () => {
  const v1 = await servedEchoPlugin("1.0.0");
  const cli = await setup({});
  const config = await cli.config();
  config.currentProfile = "a";
  config.profiles.a = {
    server: "http://127.0.0.1:1",
    plugins: { echo: { app: v1.manifest.app, version: v1.manifest.version, digest: v1.manifest.digest } },
  };
  for (const [command, reason] of [
    ["echo token-SECRET; echo nope >&2; exit 3", "nope"],
    ["echo token-SECRET; exit 3", "the token command ended with exit code 3"],
  ]) {
    config.profiles.a.tokenCommand = command;
    await writeFile(join(cli.dir, "config.json"), JSON.stringify(config));
    const result = await cli.run(["plugins", "update"]);
    expect(result).toEqual({ exitCode: 1, stdout: "", stderr: `Cannot read the token from the token command: ${reason}\n` });
    expect(result.stdout + result.stderr).not.toContain("token-SECRET");
    expect(result.stdout + result.stderr).not.toContain(command);
  }
});

test("fd0 failures report the first stderr line and continue to the next profile without exposing stdout", async () => {
  const v1 = await servedEchoPlugin("1.0.0");
  const cli = await setup({});
  const config = await cli.config();
  config.currentProfile = "a";
  for (const profile of ["a", "b"]) {
    config.profiles[profile] = {
      server: "http://127.0.0.1:1",
      fd0: { name: `${profile}-token` },
      plugins: { echo: { app: v1.manifest.app, version: v1.manifest.version, digest: v1.manifest.digest } },
    };
  }
  await writeFile(join(cli.dir, "config.json"), JSON.stringify(config));
  const bin = join(cli.dir, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "fd0"), "#!/bin/sh\nprintf 'fd0-SECRET'\nprintf '\\nfd0 agent is locked\\nmore detail\\n' >&2\nexit 1\n");
  await chmod(join(bin, "fd0"), 0o700);
  expect(await cli.run(["plugins", "update", "--all"], bin)).toEqual({
    exitCode: 1,
    stdout: "",
    stderr:
      'cld: a: Cannot read the token from fd0 item "a-token": fd0 agent is locked\ncld: b: Cannot read the token from fd0 item "b-token": fd0 agent is locked\n',
  });
  expect(await cli.run(["plugins", "update"], bin)).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: 'Cannot read the token from fd0 item "a-token": fd0 agent is locked\n',
  });
  const json = await cli.run(["plugins", "update", "--all", "--json"], bin);
  expect(json.exitCode).toBe(1);
  expect(JSON.parse(json.stdout).plugins).toEqual(
    ["a", "b"].map((profile) => ({
      profile,
      status: "failed",
      message: `Cannot read the token from fd0 item "${profile}-token": fd0 agent is locked`,
    })),
  );
  expect(json.stderr).toBe("");
});

test("profile rm signs a profile out, drops the plugin versions no other profile uses, and rewrites the skill", async () => {
  const [v1, v2] = [await servedEchoPlugin("1.0.0"), await servedEchoPlugin("2.0.0")];
  const clouds: Record<"a" | "b" | "c", PluginCloudState & { revoked: string[] }> = {
    a: { plugins: [v1], authorizations: [], revoked: [] },
    b: { plugins: [v2], authorizations: [], revoked: [] },
    c: { plugins: [v2], authorizations: [], revoked: [], revokeStatus: 503 },
  };
  const cli = await setup(clouds);
  const configPath = join(cli.dir, "config.json");
  // b and c hold OAuth logins, so removing them revokes their refresh tokens; c's Cloud refuses.
  const signedIn = await cli.config();
  for (const profile of ["b", "c"]) {
    signedIn.profiles[profile] = {
      server: signedIn.profiles[profile].server,
      oauth: {
        accessToken: `${profile}-access`,
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        refreshToken: `${profile}-refresh`,
      },
    };
  }
  await writeFile(configPath, JSON.stringify(signedIn));
  for (const profile of ["a", "b", "c"]) {
    const installed = await cli.run(["--profile", profile, "plugins", "install", "echo"]);
    expect(installed.exitCode, installed.stderr).toBe(0);
  }
  const skills = join(cli.dir, "agent-skills");
  expect((await cli.run(["skills", "add", skills])).exitCode).toBe(0);
  const skill = () => readFile(join(skills, "cloud-cli", "SKILL.md"), "utf8");
  expect(await skill()).toContain("| b | echo | 2.0.0 |");
  const before = await readFile(configPath, "utf8");

  // The current profile stays while others exist, a missing one is named, and without a terminal removal needs --yes.
  const current = await cli.run(["profile", "rm", "a", "--yes"]);
  expect(current.exitCode).toBe(1);
  expect(current.stderr).toBe('Profile "a" is the current profile. Select another one first: `cld profile use <name>` (b, c).\n');
  const german = await cli.run(["--locale", "de", "profile", "rm", "a", "--yes"]);
  expect(german.stderr).toBe('Profil "a" ist das aktuelle Profil. Wähle zuerst ein anderes: `cld profile use <Name>` (b, c).\n');
  expect((await cli.run(["profile", "rm", "missing", "--yes"])).stderr).toBe('Profile "missing" does not exist.\n');
  const unconfirmed = await cli.run(["profile", "rm", "b"]);
  expect(unconfirmed.exitCode).toBe(1);
  expect(unconfirmed.stderr).toBe("Not a terminal; pass --yes to remove the profile non-interactively.\n");
  expect(await readFile(configPath, "utf8")).toBe(before);
  expect(clouds.b.revoked).toEqual([]);

  // b is signed out at its Cloud and gone; c still locks 2.0.0, so the store and the skill keep it.
  const removed = await cli.run(["profile", "rm", "b", "--yes"]);
  expect(removed).toEqual({ exitCode: 0, stdout: 'Signed out and removed profile "b".\n', stderr: "" });
  expect(clouds.b.revoked).toEqual(["b-refresh"]);
  expect(Object.keys((await cli.config()).profiles).sort()).toEqual(["a", "c"]);
  expect(await cli.stored()).toEqual([v1.manifest.digest, v2.manifest.digest].sort());
  expect(await skill()).not.toContain("| b |");
  expect(await skill()).toContain("| c | echo | 2.0.0 |");
  expect((await cli.run(["profile", "rm", "a", "-y"])).stderr).toContain("`cld profile use c`.");

  // A refused revocation warns on stderr like `cld logout` and still removes c; stdout stays JSON.
  // c was the last profile on 2.0.0: that version leaves the store and the skill.
  const json = await cli.run(["--json", "profile", "rm", "c", "-y"]);
  expect(json.exitCode, json.stderr).toBe(0);
  expect(json.stderr).toBe("Warning: Remote OAuth revocation failed (503). Removing local credentials anyway.\n");
  expect(JSON.parse(json.stdout)).toEqual({ profile: "c", removed: true });
  expect(clouds.c.revoked).toEqual(["c-refresh"]);
  expect(await cli.stored()).toEqual([v1.manifest.digest]);
  expect(await readdir(join(skills, "cloud-cli", "references", "echo"))).toEqual(["1.0.0"]);

  // The only profile may go although it is current; nothing is current afterwards.
  const last = await cli.run(["profile", "rm", "a", "--yes"]);
  expect(last).toEqual({ exitCode: 0, stdout: 'Removed profile "a".\n', stderr: "" });
  expect(await cli.config()).toEqual({ profiles: {}, skills: { targets: ["~/agent-skills"] } });
  expect(await cli.stored()).toEqual([]);
  expect(await skill()).toContain("No module is installed for any profile yet");
  expect(clouds.a.revoked).toEqual([]);
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

test("a config from before skill targets is asked once on sync; a recorded empty list is not", async () => {
  const cli = await setup({ a: { plugins: [], authorizations: [] } });
  const defaultTarget = join(cli.dir, ".agents", "skills");

  // No terminal and no --yes: nothing is asked, recorded, or written; one line names the command.
  const unasked = await cli.run(["skills", "sync"]);
  expect(unasked.exitCode).toBe(1);
  expect(unasked.stderr.trim().split("\n")).toHaveLength(1);
  expect(unasked.stderr).toContain("cld skills add ~/.agents/skills");
  expect((await cli.config()).skills).toBeUndefined();
  expect(await readdir(defaultTarget).catch(() => [])).toEqual([]);

  // --yes records and writes the default target.
  const accepted = await cli.run(["--json", "skills", "sync", "--yes"]);
  expect(accepted.exitCode, accepted.stderr).toBe(0);
  expect(JSON.parse(accepted.stdout)).toEqual({ written: [join(defaultTarget, "cloud-cli")] });
  expect((await cli.config()).skills).toEqual({ targets: ["~/.agents/skills"] });
  expect(await readFile(join(defaultTarget, "cloud-cli", "SKILL.md"), "utf8")).toContain("# ");

  // After `skills remove`, the empty list is an answer: --yes does not ask again.
  expect((await cli.run(["skills", "remove", "~/.agents/skills"])).exitCode).toBe(0);
  const declined = await cli.run(["skills", "sync", "--yes"]);
  expect(declined.exitCode).toBe(1);
  expect((await cli.config()).skills).toEqual({ targets: [] });
  expect(await readdir(defaultTarget)).toEqual([]);
}, 30_000);

test("profile short names run the installed module and appear in help and plugin lists", async () => {
  const plugin = await servedEchoPlugin("1.0.0", "short-names", { name: "echo", alias: "e", shortcuts: { me: "whoami" } });
  const cloud: PluginCloudState = { plugins: [plugin], authorizations: [] };
  const cli = await setup({ a: cloud, b: { plugins: [], authorizations: [] } });
  const installed = await cli.run(["plugins", "install", "echo"]);
  expect(installed.exitCode, installed.stderr).toBe(0);
  const profile = (await cli.config()).profiles.a;
  expect(profile.plugins.echo).toMatchObject({ alias: "e", shortcuts: { me: "whoami" } });
  expect(profile.servedPlugins).toEqual(["echo"]);
  for (const args of [["e", "whoami"], ["me"]]) {
    const result = await cli.run(["--json", ...args]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ authorization: "Bearer token-a", profile: "a" });
  }
  const aliasHelp = await cli.run(["e", "--help"]);
  expect(aliasHelp.exitCode, aliasHelp.stderr).toBe(0);
  expect(aliasHelp.stdout).toContain("whoami");
  expect(aliasHelp.stdout).toBe((await cli.run(["echo", "--help"])).stdout);
  expect((await cli.run(["e", "reference"])).stdout).toBe("# Echo 1.0.0\n");
  const shortcutReference = await cli.run(["me", "reference"]);
  expect(shortcutReference.exitCode).toBe(1);
  expect(shortcutReference.stderr).toContain("Unexpected argument: reference.");
  const help = await cli.run(["help"]);
  expect(help.stderr).toBe("");
  expect(help.stdout).toContain("echo (e)");
  expect(help.stdout).toContain("Shortcuts:\n  me → echo whoami");
  expect((await cli.run(["--locale", "de", "help"])).stdout).toContain("Kurzbefehle:");
  const listed = await cli.run(["plugins", "list", "--json"]);
  expect(JSON.parse(listed.stdout).plugins[0]).toMatchObject({ alias: "e", shortcuts: { me: "whoami" }, inactive: [] });
  expect((await cli.run(["plugins", "list"])).stdout).toContain("SHORT NAMES");
  expect((await cli.run(["--locale", "de", "plugins", "list"])).stdout).toContain("KURZNAMEN");
  expect((await cli.run(["--profile", "b", "e", "whoami"])).stderr).toContain('Unknown command "e"');

  // Updating the identical stored bundle fills metadata missing from an older lock.
  const old = await cli.config();
  delete old.profiles.a.plugins.echo.alias;
  delete old.profiles.a.plugins.echo.shortcuts;
  old.profiles.a.plugins.echo.summary = "Old summary";
  delete old.profiles.a.servedPlugins;
  await writeFile(join(cli.dir, "config.json"), JSON.stringify(old));
  const updated = await cli.run(["plugins", "update", "--json"]);
  expect(updated.exitCode, updated.stderr).toBe(0);
  expect(JSON.parse(updated.stdout).plugins[0].status).toBe("unchanged");
  expect((await cli.config()).profiles.a).toEqual(profile);
}, 30_000);

test("conflicting short names are inactive for every claimant with localized diagnostics", async () => {
  const plugins = [
    await servedEchoPlugin("1.0.0", "first", { name: "echo", alias: "e" }),
    await servedEchoPlugin("1.0.0", "second", { name: "foo", alias: "e" }),
  ];
  const cli = await setup({ a: { plugins, authorizations: [] } });
  const warning = 'cld: "e" is ambiguous (echo, foo); use the full module name.';
  expect((await cli.run(["plugins", "install", "--all"])).stderr).toContain(warning);
  expect((await cli.run(["plugins", "install", "--all"])).stderr).toContain(warning);
  const ambiguous = await cli.run(["e", "whoami"]);
  expect(ambiguous.exitCode).toBe(1);
  expect(ambiguous.stderr.trim()).toBe("`e` is ambiguous: echo, foo. Use the full name.");
  expect((await cli.run(["--locale", "de", "e", "whoami"])).stderr.trim()).toBe("`e` ist mehrdeutig: echo, foo. Nutze den vollen Namen.");
  const help = await cli.run(["help"]);
  expect(help.stderr.trim()).toBe(warning);
  expect(help.stdout).not.toContain("echo (e)");
  expect((await cli.run(["--locale", "de", "help"])).stderr).toContain('"e" ist mehrdeutig (echo, foo)');
  const list = await cli.run(["plugins", "list"]);
  expect(list.stderr.trim()).toBe(warning);
  expect(list.stdout).toContain("e (inactive)");
  expect((await cli.run(["--locale", "de", "plugins", "list"])).stdout).toContain("e (inaktiv)");
  const json = await cli.run(["plugins", "list", "--json"]);
  expect(JSON.parse(json.stdout).plugins.map((row: { inactive: string[] }) => row.inactive)).toEqual([["e"], ["e"]]);
  expect((await cli.run(["plugins", "update"])).stderr.trim()).toBe(warning);
}, 30_000);

test("served but uninstalled module names stay reserved offline and snapshots refresh with no staged plugins", async () => {
  const cloud: PluginCloudState = {
    plugins: [
      await servedEchoPlugin("1.0.0", "alias", { name: "echo", alias: "mail" }),
      await servedEchoPlugin("1.0.0", "mail", { name: "mail" }),
    ],
    authorizations: [],
  };
  const cli = await setup({ a: cloud });
  const installed = await cli.run(["plugins", "install", "echo"]);
  expect(installed.stderr).toContain('"mail" from echo is inactive: a module has that name.');
  expect((await cli.config()).profiles.a.servedPlugins).toEqual(["echo", "mail"]);
  const before = cloud.authorizations.length;
  const result = await cli.run(["mail", "whoami"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('Unknown command "mail"');
  expect(result.stderr).toContain("cld plugins install mail");
  expect(cloud.authorizations.length).toBe(before);

  cloud.plugins = [cloud.plugins[0]!];
  expect((await cli.run(["plugins", "update"])).exitCode).toBe(0);
  expect((await cli.config()).profiles.a.servedPlugins).toEqual(["echo"]);
  expect((await cli.run(["mail", "whoami"])).exitCode).toBe(0);
  // A failed list preserves the snapshot without failing an otherwise valid install/update.
  const old = await cli.config();
  old.profiles.a.servedPlugins = ["echo", "mail"];
  await writeFile(join(cli.dir, "config.json"), JSON.stringify(old));
  cloud.listStatus = 403;
  expect((await cli.run(["plugins", "update"])).exitCode).toBe(0);
  expect((await cli.config()).profiles.a.servedPlugins).toEqual(["echo", "mail"]);
}, 30_000);

test("missing served snapshots keep short names inactive until a successful list", async () => {
  const echo = await servedEchoPlugin("1.0.0", "unverified", { name: "echo", alias: "mail" });
  const cloud: PluginCloudState = {
    plugins: [echo, await servedEchoPlugin("1.0.0", "mail", { name: "mail" })],
    authorizations: [],
    listStatus: 503,
  };
  const cli = await setup({ a: cloud });
  const installed = await cli.run(["plugins", "install", "echo"]);
  expect(installed.exitCode, installed.stderr).toBe(0);
  expect((await cli.config()).profiles.a.servedPlugins).toBeUndefined();
  const before = cloud.authorizations.length;
  const blocked = await cli.run(["mail", "whoami"]);
  expect(blocked.exitCode).toBe(1);
  expect(blocked.stderr).toContain('Unknown command "mail"');
  expect(blocked.stderr).toContain("cld plugins install mail");
  const help = await cli.run(["help"]);
  expect(help.exitCode, help.stderr).toBe(0);
  expect(help.stderr).toContain(
    'cld: "mail" from echo is inactive until cld knows which modules your Cloud serves; run `cld plugins list`.',
  );
  expect(cloud.authorizations.length).toBe(before);

  cloud.listStatus = undefined;
  const listed = await cli.run(["plugins", "list", "--json"]);
  expect(listed.exitCode, listed.stderr).toBe(0);
  expect((await cli.config()).profiles.a.servedPlugins).toEqual(["echo", "mail"]);
  expect(JSON.parse(listed.stdout).plugins.find((row: { name: string }) => row.name === "echo")).toMatchObject({ inactive: ["mail"] });

  cloud.plugins = [echo];
  expect((await cli.run(["plugins", "list"])).exitCode).toBe(0);
  expect((await cli.config()).profiles.a.servedPlugins).toEqual(["echo"]);
  expect((await cli.run(["mail", "whoami"])).exitCode).toBe(0);
}, 30_000);

test("listing refreshes stale served names before rendering short names and warnings", async () => {
  const echo = await servedEchoPlugin("1.0.0", "stale", { name: "echo", alias: "mail" });
  const cloud: PluginCloudState = { plugins: [echo], authorizations: [] };
  const cli = await setup({ a: cloud });
  expect((await cli.run(["plugins", "install", "echo"])).exitCode).toBe(0);
  expect((await cli.config()).profiles.a.servedPlugins).toEqual(["echo"]);
  expect((await cli.run(["mail", "whoami"])).exitCode).toBe(0);

  cloud.plugins.push(await servedEchoPlugin("1.0.0", "mail", { name: "mail" }));
  const listed = await cli.run(["plugins", "list"]);
  expect(listed.exitCode, listed.stderr).toBe(0);
  expect(listed.stdout).toContain("mail (inactive)");
  expect(listed.stderr).toContain('"mail" from echo is inactive: a module has that name.');
  expect((await cli.config()).profiles.a.servedPlugins).toEqual(["echo", "mail"]);
  const json = await cli.run(["plugins", "list", "--json"]);
  expect(json.exitCode, json.stderr).toBe(0);
  expect(JSON.parse(json.stdout).plugins.find((row: { name: string }) => row.name === "echo")).toMatchObject({ inactive: ["mail"] });
  const before = cloud.authorizations.length;
  const blocked = await cli.run(["mail", "whoami"]);
  expect(blocked.exitCode).toBe(1);
  expect(blocked.stderr).toContain('Unknown command "mail"');
  expect(blocked.stderr).toContain("cld plugins install mail");
  expect(cloud.authorizations.length).toBe(before);
}, 30_000);

test("malformed served snapshots count as missing without crashing help", async () => {
  const cloud: PluginCloudState = {
    plugins: [await servedEchoPlugin("1.0.0", "malformed", { name: "echo", alias: "e" })],
    authorizations: [],
  };
  const cli = await setup({ a: cloud });
  expect((await cli.run(["plugins", "install", "echo"])).exitCode).toBe(0);
  for (const value of [5, "e"]) {
    const config = await cli.config();
    config.profiles.a.servedPlugins = value;
    await writeFile(join(cli.dir, "config.json"), JSON.stringify(config));
    const before = cloud.authorizations.length;
    const help = await cli.run(["help"]);
    expect(help.exitCode, help.stderr).toBe(0);
    expect(help.stderr).toContain('"e" from echo is inactive until cld knows which modules your Cloud serves');
    const german = await cli.run(["--locale", "de", "help"]);
    expect(german.exitCode, german.stderr).toBe(0);
    expect(german.stderr).toContain(
      'cld: "e" von echo ist inaktiv, bis cld weiß, welche Module deine Cloud bereitstellt; führe `cld plugins list` aus.',
    );
    const blocked = await cli.run(["e", "whoami"]);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr).toContain('Unknown command "e"');
    expect(cloud.authorizations.length).toBe(before);
  }
}, 30_000);

test("installing a package plugin warns when its ID takes a shortcut's name", async () => {
  const cloud: PluginCloudState = {
    plugins: [await servedEchoPlugin("1.0.0", "package-warning", { name: "echo", shortcuts: { me: "whoami" } })],
    authorizations: [],
  };
  const cli = await setup({ a: cloud });
  expect((await cli.run(["plugins", "install", "echo"])).exitCode).toBe(0);
  expect((await cli.run(["me"])).exitCode).toBe(0);
  const directory = join(cli.dir, "package-me");
  await packInlinePlugin(
    directory,
    `export default {
    name: "me", summary: "Package fixture", requiresCloud: false,
    run: (ctx) => { ctx.print("package me"); return 0; },
  };`,
  );
  const installed = await cli.run(["plugins", "install", directory, "--yes"]);
  expect(installed.exitCode, installed.stderr).toBe(0);
  expect(installed.stdout).toContain('Installed plugin "me"');
  expect(installed.stderr).toContain('"me" from echo is inactive: a module has that name.');
  expect((await cli.run(["me"])).stdout).toBe("package me\n");
}, 30_000);

test("built-ins and package module names win, while package short-name declarations are ignored", async () => {
  const cloud: PluginCloudState = {
    plugins: [
      await servedEchoPlugin("1.0.0", "reserved", { name: "echo", alias: "constructor", shortcuts: { e: "whoami", help: "whoami" } }),
    ],
    authorizations: [],
  };
  const cli = await setup({ a: cloud });
  const installed = await cli.run(["plugins", "install", "echo"]);
  expect(installed.exitCode, installed.stderr).toBe(0);
  expect(installed.stderr).toContain('"help" from echo is inactive: a built-in command has that name.');
  expect((await cli.run(["constructor", "whoami"])).exitCode).toBe(0);
  expect((await cli.run(["e"])).exitCode).toBe(0);

  const directory = join(cli.dir, "package-e");
  await packInlinePlugin(
    directory,
    `export default {
    name: "e", summary: "Package fixture", alias: "pkg", shortcuts: { pack: "run" }, requiresCloud: false,
    help: () => "Package e help", run: (ctx) => { ctx.print("package " + ctx.args.join(" ")); return 0; },
  };`,
  );
  expect((await cli.run(["plugins", "install", directory, "--yes"])).exitCode).toBe(0);
  expect((await cli.run(["e", "anything"])).stdout).toBe("package anything\n");
  expect((await cli.run(["e", "--help"])).stdout).toBe("Package e help\n");
  const help = await cli.run(["help"]);
  expect(help.stderr).toContain('"e" from echo is inactive: a module has that name.');
  expect(help.stderr).toContain('"help" from echo is inactive: a built-in command has that name.');
  const germanHelp = await cli.run(["--locale", "de", "help"]);
  expect(germanHelp.stderr).toContain('"e" von echo ist inaktiv: ein Modul heißt so.');
  expect(germanHelp.stderr).toContain('"help" von echo ist inaktiv: ein eingebauter Befehl heißt so.');
  const before = cloud.authorizations.length;
  for (const name of ["pkg", "pack"]) {
    expect((await cli.run([name])).stderr).toContain(`Unknown command "${name}"`);
  }
  expect(cloud.authorizations.length).toBe(before);
  const listed = await cli.run(["plugins", "list", "--json"]);
  expect(JSON.parse(listed.stdout).plugins).toContainEqual({
    profile: null,
    name: "e",
    app: "test-plugin",
    installed: "1.0.0",
    available: null,
    status: "ok",
    source: directory,
    alias: null,
    shortcuts: {},
    inactive: [],
  });
}, 30_000);
