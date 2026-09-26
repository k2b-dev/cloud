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
