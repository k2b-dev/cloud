import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type PollAnswer = "authorization_pending" | "slow_down" | "access_denied" | "expired_token" | "approve";

type DeviceServerState = {
  starts: URLSearchParams[];
  polls: { at: number; body: URLSearchParams }[];
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const configPath = async () => {
  const dir = await mkdtemp(join(tmpdir(), "cld-device-test-"));
  tempDirs.push(dir);
  return join(dir, "config.json");
};

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const idToken = `${base64url({ alg: "none" })}.${base64url({ sub: "user-id", name: "Valentin Kolb" })}.signature`;

/** A Cloud stand-in that answers device polls from a script. */
const startDeviceServer = (answers: PollAnswer[], options: { supportsDevice?: boolean } = {}) => {
  const state: DeviceServerState = { starts: [], polls: [] };
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/oauth/device_authorization" && options.supportsDevice !== false) {
        state.starts.push(new URLSearchParams(await request.text()));
        return Response.json({
          device_code: "device-code-secret",
          user_code: "WDJB-MJHT",
          verification_uri: `${url.origin}/oauth/device`,
          verification_uri_complete: `${url.origin}/oauth/device?user_code=WDJB-MJHT`,
          expires_in: 30,
          interval: 0.05,
        });
      }
      if (url.pathname === "/oauth/token") {
        const body = new URLSearchParams(await request.text());
        state.polls.push({ at: Date.now(), body });
        const answer = answers.shift() ?? "expired_token";
        if (answer !== "approve") return Response.json({ error: answer }, { status: 400 });
        return Response.json({
          access_token: "device-access",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid profile email offline_access read write",
          refresh_token: "device-refresh",
          id_token: idToken,
        });
      }
      return Response.json({ message: "not found" }, { status: 404 });
    },
  });
  return { server, state, origin: `http://127.0.0.1:${server.port}` };
};

// A controlled environment: no SSH session and a display, so only the flags decide.
const localDesktop = { SSH_CONNECTION: "", SSH_TTY: "", DISPLAY: ":0" };

const runCli = async (config: string, args: string[], env: Record<string, string> = localDesktop) => {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", "packages/cloud-cli/src/index.ts", ...args],
    cwd: process.cwd(),
    env: { ...process.env, ...env, CLD_CONFIG: config },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode, stdout, stderr };
};

const readConfig = async (path: string) =>
  JSON.parse(await readFile(path, "utf8")) as {
    currentProfile: string;
    profiles: Record<string, { server: string; oauth: { accessToken: string; refreshToken: string; scope: string } }>;
  };

describe("cld login --device", () => {
  test("prints the code and both URLs, polls until approval, and stores the profile like a normal login", async () => {
    const { server, state, origin } = startDeviceServer(["authorization_pending", "authorization_pending", "approve"]);
    const config = await configPath();
    try {
      const result = await runCli(config, ["login", "portal", "--server", origin, "--device"]);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        [
          `Open ${origin}/oauth/device and enter the code: WDJB-MJHT`,
          `(or open ${origin}/oauth/device?user_code=WDJB-MJHT)`,
          "Waiting for approval…",
          '✓ Signed in as Valentin Kolb (profile "portal")',
          "",
        ].join("\n"),
      );

      expect(state.starts).toHaveLength(1);
      expect(state.starts[0]?.get("client_id")).toBe("cloud-cli");
      expect(state.starts[0]?.get("scope")).toBe("openid profile email offline_access read write");
      expect(state.polls).toHaveLength(3);
      for (const poll of state.polls) {
        expect(poll.body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
        expect(poll.body.get("device_code")).toBe("device-code-secret");
        expect(poll.body.get("client_id")).toBe("cloud-cli");
      }

      const stored = await readConfig(config);
      expect(stored.currentProfile).toBe("portal");
      expect(stored.profiles.portal?.server).toBe(origin);
      expect(stored.profiles.portal?.oauth.accessToken).toBe("device-access");
      expect(stored.profiles.portal?.oauth.refreshToken).toBe("device-refresh");
    } finally {
      server.stop(true);
    }
  });

  test("follows the CLI locale", async () => {
    const { server, origin } = startDeviceServer(["approve"]);
    const config = await configPath();
    try {
      const result = await runCli(config, ["--locale", "de", "login", "--server", origin, "--device"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Öffne ${origin}/oauth/device und gib den Code ein: WDJB-MJHT`);
      expect(result.stdout).toContain(`(oder öffne ${origin}/oauth/device?user_code=WDJB-MJHT)`);
      expect(result.stdout).toContain("Warte auf Bestätigung…");
      expect(result.stdout).toContain('✓ Angemeldet als Valentin Kolb (Profil "default")');
    } finally {
      server.stop(true);
    }
  });

  test("slow_down adds five seconds to the polling interval", async () => {
    const { server, state, origin } = startDeviceServer(["slow_down", "approve"]);
    const config = await configPath();
    try {
      const result = await runCli(config, ["login", "--server", origin, "--device"]);
      expect(result.exitCode).toBe(0);
      const [first, second] = state.polls;
      expect(second!.at - first!.at).toBeGreaterThanOrEqual(5_000);
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test("a denied or expired code fails without storing a login", async () => {
    const denied = startDeviceServer(["authorization_pending", "access_denied"]);
    const config = await configPath();
    try {
      const result = await runCli(config, ["login", "--server", denied.origin, "--device"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Sign-in was denied in the browser.");
      expect(await Bun.file(config).exists()).toBe(false);
    } finally {
      denied.server.stop(true);
    }

    const expired = startDeviceServer(["expired_token"]);
    try {
      const result = await runCli(config, ["--locale", "de", "login", "--server", expired.origin, "--device"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Der Code ist abgelaufen, bevor er bestätigt wurde.");
      expect(await Bun.file(config).exists()).toBe(false);
    } finally {
      expired.server.stop(true);
    }
  });

  test("explains when the server does not offer device sign-in", async () => {
    const { server, origin } = startDeviceServer([], { supportsDevice: false });
    const config = await configPath();
    try {
      const result = await runCli(config, ["login", "--server", origin, "--device"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("This Cloud server does not support device sign-in yet.");
    } finally {
      server.stop(true);
    }
  });

  test("login help documents --device in English and German", async () => {
    const config = await configPath();
    const english = await runCli(config, ["login", "--help"]);
    expect(english.exitCode).toBe(0);
    expect(english.stdout).toContain("--device              Sign in with a code instead of a local browser.");
    expect(english.stdout).toContain("cld login portal --server https://cloud.example --device");
    const german = await runCli(config, ["--locale", "de", "login", "--help"]);
    expect(german.stdout).toContain("--device              Mit einem Code statt mit einem lokalen Browser anmelden.");
  });
});

describe("cld login without --device", () => {
  const firstLines = async (env: Record<string, string>, args: string[] = []) => {
    const config = await configPath();
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", "packages/cloud-cli/src/index.ts", "login", "--server", "http://127.0.0.1:9", ...args],
      cwd: process.cwd(),
      env: { ...process.env, ...env, CLD_CONFIG: config },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    // Both locales end the preamble with the waiting line.
    while (!/Open the URL above in a browser\.|Öffne die URL oben in einem Browser\./.test(output)) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
    proc.kill();
    await proc.exited;
    return output;
  };

  test("suggests --device in an SSH session and with --no-open, but not on a local desktop", async () => {
    const hint = "run `cld login --device` instead.";
    expect(await firstLines({ ...localDesktop, SSH_CONNECTION: "203.0.113.5 50000 198.51.100.7 22" })).toContain(hint);
    expect(await firstLines(localDesktop, ["--no-open"])).toContain(hint);
    expect(await firstLines({ ...localDesktop, SSH_CONNECTION: "203.0.113.5 50000 198.51.100.7 22", CLD_LOCALE: "de" })).toContain(
      "führe stattdessen `cld login --device` aus.",
    );
    const local = await firstLines(localDesktop);
    expect(local).toContain("Login URL:");
    expect(local).not.toContain("--device");
  });
});
