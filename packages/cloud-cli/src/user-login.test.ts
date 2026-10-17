import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

type PollAnswer = "authorization_pending" | "slow_down" | "access_denied" | "expired_token" | "invalid_grant" | "approve";
type Login = { method: "browser" | "device" | "user"; user?: string; ttl?: number; scope?: string };
type Session = {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken?: string;
  refreshTokenFd0?: { name: string; scope?: string };
  loginExpiresAt?: string;
  login?: Login;
};

const DEFAULT_SCOPE = "openid profile email offline_access read write";
const tempDirs: string[] = [];
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const configPath = async () => {
  const dir = await mkdtemp(join(tmpdir(), "cld-user-test-"));
  tempDirs.push(dir);
  return join(dir, "config.json");
};

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const idToken = `${base64url({ alg: "none" })}.${base64url({ sub: "user-id", name: "Valentin Kolb" })}.signature`;

/** Both device variants and browser exchanges use the same fake Cloud. */
const startServer = (
  answers: PollAnswer[] = ["approve"],
  options: {
    hintSupported?: boolean;
    ttlSupported?: boolean;
    discoveryStatus?: number;
    discoveryJson?: string;
    startStatus?: number;
    startError?: string;
    startResponse?: unknown;
    tokenResponse?: unknown;
    loginSeconds?: number;
    expiresIn?: number;
    interval?: number;
    pending?: boolean;
    tokenDelayMs?: number;
    onPlugins?: () => Promise<Response>;
  } = {},
) => {
  const state = {
    requests: [] as string[],
    starts: [] as URLSearchParams[],
    locales: [] as (string | null)[],
    tokens: [] as { at: number; body: URLSearchParams }[],
  };
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      state.requests.push(url.pathname);
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        if (options.discoveryJson !== undefined) return new Response(options.discoveryJson);
        return Response.json(
          {
            cloud_login_hint_supported: options.hintSupported ?? true,
            cloud_login_ttl_supported: options.ttlSupported ?? true,
          },
          { status: options.discoveryStatus ?? 200 },
        );
      }
      if (url.pathname === "/oauth/device_authorization") {
        const body = new URLSearchParams(await request.text());
        state.starts.push(body);
        state.locales.push(request.headers.get("accept-language"));
        if (options.startStatus) {
          return Response.json(
            { error: options.startError, error_description: "unknown account, no paired phone" },
            { status: options.startStatus },
          );
        }
        return Response.json(
          options.startResponse ?? {
            device_code: "device-code-secret",
            ...(body.has("login_hint")
              ? { comparison: "623775" }
              : { user_code: "WDJB-MJHT", verification_uri: `${url.origin}/oauth/device` }),
            expires_in: options.expiresIn ?? 30,
            interval: options.interval ?? 0.05,
          },
        );
      }
      if (url.pathname === "/oauth/token") {
        const body = new URLSearchParams(await request.text());
        state.tokens.push({ at: Date.now(), body });
        if (options.tokenDelayMs) await Bun.sleep(options.tokenDelayMs);
        const answer =
          body.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code"
            ? (answers.shift() ?? (options.pending ? "authorization_pending" : "expired_token"))
            : "approve";
        if (answer !== "approve") {
          return Response.json({ error: answer, error_description: "unknown account, no paired phone" }, { status: 400 });
        }
        return Response.json(
          options.tokenResponse ?? {
            access_token: "access-token-secret",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "refresh-token-secret",
            refresh_token_expires_in: options.loginSeconds ?? 28800,
            scope: DEFAULT_SCOPE,
            id_token: idToken,
          },
        );
      }
      if (url.pathname === "/cli/plugins") return options.onPlugins ? options.onPlugins() : Response.json({ plugins: [] });
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  cleanups.push(() => {
    server.stop(true);
  });
  return { server, state, origin: `http://127.0.0.1:${server.port}` };
};

const startCli = (config: string, args: string[]) => {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", "packages/cloud-cli/src/index.ts", ...args],
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLD_LOCALE: "",
      CLD_TOKEN: "",
      CLD_SERVER: "",
      LC_ALL: "",
      LC_MESSAGES: "",
      LANG: "C",
      CLD_CONFIG: config,
      XDG_CONFIG_HOME: dirname(config),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanups.push(async () => {
    if (proc.exitCode === null) proc.kill();
    await proc.exited;
  });
  // Collect stdout as it arrives, so a test can wait for a line and still read the rest.
  let seen = "";
  const stdout = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) seen += decoder.decode(chunk, { stream: true });
    return seen;
  })();
  return { proc, stdout, seen: () => seen };
};

const finishCli = async (cli: ReturnType<typeof startCli>) => {
  const [exitCode, stdout, stderr] = await Promise.all([cli.proc.exited, cli.stdout, new Response(cli.proc.stderr).text()]);
  return { exitCode, stdout, stderr };
};
const runCli = (config: string, args: string[]) => finishCli(startCli(config, args));

const readUntil = async (cli: ReturnType<typeof startCli>, marker: string) => {
  const deadline = Date.now() + 10_000;
  while (!cli.seen().includes(marker) && cli.proc.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
  expect(cli.seen()).toContain(marker);
  return cli.seen();
};

const readConfig = async (path: string) =>
  JSON.parse(await readFile(path, "utf8")) as {
    currentProfile: string;
    profiles: Record<string, { server: string; oauth: Session }>;
  };

const writeSession = (config: string, origin: string, session: Partial<Session> = {}, profile = "portal") =>
  writeFile(
    config,
    JSON.stringify({
      currentProfile: profile,
      profiles: {
        [profile]: {
          server: origin,
          oauth: {
            accessToken: "stored-access",
            refreshToken: "stored-refresh",
            accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
            ...session,
          },
        },
      },
    }),
  );

const expectExpiry = (value: string | undefined, seconds: number, before: number, after: number) => {
  expect(value).toBeString();
  const timestamp = Date.parse(value ?? "");
  expect(timestamp).toBeGreaterThanOrEqual(before + seconds * 1000);
  expect(timestamp).toBeLessThanOrEqual(after + seconds * 1000);
};

const userArgs = (origin: string) => ["login", "portal", "--server", origin, "--user", "  alice@example.test  ", "--no-plugins"];
const deviceCommand = (origin: string) => `cld login portal --server ${origin} --device`;

const expectNoSecrets = (output: string) => {
  for (const secret of ["device-code-secret", "access-token-secret", "refresh-token-secret"]) expect(output).not.toContain(secret);
};

describe("cld login --user", () => {
  test("compares the code, polls pending twice, stores the login and prints the server's expiry", async () => {
    const { state, origin } = startServer(["authorization_pending", "authorization_pending", "approve"]);
    const config = await configPath();
    const before = Date.now();
    const result = await runCli(config, [...userArgs(origin), "--ttl", "8h"]);
    const after = Date.now();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Compare this code in Cloud Login: 623 775\nWaiting for approval… (Ctrl+C cancels)\n");
    expect(result.stdout).toContain('✓ Signed in as Valentin Kolb (profile "portal")');
    expectNoSecrets(result.stdout + result.stderr);
    expect(state.requests[0]).toBe("/.well-known/oauth-authorization-server");
    expect(state.requests.filter((path) => path.includes(".well-known"))).toHaveLength(1);
    expect(state.starts).toHaveLength(1);
    expect(Object.fromEntries(state.starts[0]!)).toEqual({
      client_id: "cloud-cli",
      scope: DEFAULT_SCOPE,
      login_hint: "alice@example.test",
      ttl: "28800",
    });
    expect(state.locales).toEqual([null]);
    expect(state.tokens).toHaveLength(3);
    for (const { body } of state.tokens) {
      expect(Object.fromEntries(body)).toEqual({
        client_id: "cloud-cli",
        device_code: "device-code-secret",
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
    }
    const stored = await readConfig(config);
    expect(stored.currentProfile).toBe("portal");
    expect(stored.profiles.portal?.server).toBe(origin);
    const session = stored.profiles.portal?.oauth;
    expect(session?.accessToken).toBe("access-token-secret");
    expect(session?.refreshToken).toBe("refresh-token-secret");
    expect(session?.login).toEqual({ method: "user", user: "alice@example.test", ttl: 28800 });
    expectExpiry(session?.loginExpiresAt, 28800, before, after);
    expect(result.stdout).toContain(`Login expires: ${session?.loginExpiresAt}`);
  });

  test("uses German, forwards Accept-Language, and omits ttl when it was not requested", async () => {
    const { state, origin } = startServer();
    const config = await configPath();
    const result = await runCli(config, ["--locale", "de", ...userArgs(origin)]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Vergleiche diesen Code in Cloud Login: 623 775");
    expect(result.stdout).toContain("Warte auf Bestätigung… (Strg+C bricht ab)");
    expect(result.stdout).toContain('✓ Angemeldet als Valentin Kolb (Profil "portal")');
    expect(result.stdout).toContain("Anmeldung läuft ab:");
    expect(state.locales).toEqual(["de"]);
    expect(state.starts[0]?.has("ttl")).toBe(false);
    expect((await readConfig(config)).profiles.portal?.oauth.login).toEqual({ method: "user", user: "alice@example.test" });
  });

  test("slow_down adds five seconds to the Cloud Login polling interval", async () => {
    const { state, origin } = startServer(["slow_down", "approve"]);
    const result = await runCli(await configPath(), userArgs(origin));
    expect(result.exitCode).toBe(0);
    expect(state.tokens).toHaveLength(2);
    expect(state.tokens[1]!.at - state.tokens[0]!.at).toBeGreaterThanOrEqual(5000);
  }, 15000);

  for (const locale of ["en", "de"]) {
    test(`denial is localised and stores nothing (${locale})`, async () => {
      const { origin } = startServer(["access_denied"]);
      const config = await configPath();
      const result = await runCli(config, ["--locale", locale, ...userArgs(origin)]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        locale === "en" ? "Sign-in was denied in Cloud Login." : "Die Anmeldung wurde in Cloud Login abgelehnt.",
      );
      expect(result.stderr).not.toContain("unknown account");
      expect(await Bun.file(config).exists()).toBe(false);
    });

    test(`expiry offers a device command without revealing account state (${locale})`, async () => {
      const { origin } = startServer(["expired_token"]);
      const config = await configPath();
      const result = await runCli(config, [
        "--locale",
        locale,
        ...userArgs(origin),
        "--ttl",
        "8h",
        "--scope",
        "openid offline_access read",
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        locale === "en"
          ? "No confirmation received. Is Cloud Login paired for this account?"
          : "Keine Bestätigung erhalten. Ist Cloud Login für dieses Konto gekoppelt?",
      );
      expect(result.stderr).toContain(`${deviceCommand(origin)} --ttl 8h --scope 'openid offline_access read'`);
      for (const phrase of ["not found", "unknown", "does not exist", "no account", "no paired phone"]) {
        expect(result.stderr.toLowerCase()).not.toContain(phrase);
      }
      expect(await Bun.file(config).exists()).toBe(false);
    });
  }

  test("a passed deadline stops polling and offers the device fallback", async () => {
    const { state, origin } = startServer([], { pending: true, expiresIn: 0.15, interval: 0.05 });
    const config = await configPath();
    const result = await runCli(config, userArgs(origin));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No confirmation received.");
    expect(result.stderr).toContain(deviceCommand(origin));
    expect(state.tokens.length).toBeLessThanOrEqual(2);
    expect(await Bun.file(config).exists()).toBe(false);
  });

  test("invalid_grant stops polling without storing tokens", async () => {
    const { state, origin } = startServer(["invalid_grant", "approve"]);
    const config = await configPath();
    const result = await runCli(config, userArgs(origin));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Cloud Login sign-in failed:");
    expect(result.stderr).not.toContain("unknown account");
    expect(result.stderr).not.toContain("no paired phone");
    expect(state.tokens).toHaveLength(1);
    expect(await Bun.file(config).exists()).toBe(false);
  });

  for (const options of [{ hintSupported: false }, { discoveryJson: "{}" }, { discoveryStatus: 404 }]) {
    test(`refuses older Clouds before device authorization (${JSON.stringify(options)})`, async () => {
      const { state, origin } = startServer([], options);
      const config = await configPath();
      const result = await runCli(config, userArgs(origin));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("This Cloud cannot send sign-ins to Cloud Login yet.");
      expect(result.stderr).toContain(deviceCommand(origin));
      expect(state.starts).toHaveLength(0);
      expect(state.requests).toEqual(["/.well-known/oauth-authorization-server"]);
      expect(await Bun.file(config).exists()).toBe(false);
    });
  }

  for (const [status, error, en, de] of [
    [400, "invalid_scope", "Cloud Login cannot approve these scopes.", "Cloud Login kann diese Scopes nicht bestätigen."],
    [
      400,
      "invalid_request",
      "This Cloud does not accept sign-ins through Cloud Login right now.",
      "Diese Cloud nimmt gerade keine Anmeldungen über Cloud Login an.",
    ],
    [
      503,
      "temporarily_unavailable",
      "Cloud Login cannot take the sign-in right now.",
      "Cloud Login kann die Anmeldung gerade nicht annehmen.",
    ],
    [
      404,
      "not_found",
      "This Cloud cannot send sign-ins to Cloud Login yet.",
      "Diese Cloud kann Anmeldungen noch nicht an Cloud Login senden.",
    ],
  ] as const) {
    test(`start error ${error} offers safe localised fallback commands`, async () => {
      const { state, origin } = startServer([], { startStatus: status, startError: error });
      for (const locale of ["en", "de"]) {
        const config = await configPath();
        const result = await runCli(config, ["--locale", locale, ...userArgs(origin)]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(locale === "en" ? en : de);
        expect(result.stderr).toContain(deviceCommand(origin));
        expect(result.stderr).not.toContain("unknown account");
        expect(await Bun.file(config).exists()).toBe(false);
      }
      expect(state.tokens).toHaveLength(0);
    });
  }

  for (const locale of ["en", "de"]) {
    test(`SIGINT cancels immediately and stops future polls (${locale})`, async () => {
      const { state, origin } = startServer([], { pending: true });
      const config = await configPath();
      const cli = startCli(config, ["--locale", locale, ...userArgs(origin)]);
      const output = await readUntil(
        cli,
        locale === "en" ? "Waiting for approval… (Ctrl+C cancels)" : "Warte auf Bestätigung… (Strg+C bricht ab)",
      );
      cli.proc.kill("SIGINT");
      const result = await finishCli(cli);
      expect(result.exitCode).toBe(130);
      expect(result.stderr).toContain(
        locale === "en"
          ? "Sign-in cancelled. A request that reached Cloud Login expires on its own within 5 minutes."
          : "Anmeldung abgebrochen. Eine Anfrage, die Cloud Login erreicht hat, läuft innerhalb von 5 Minuten von selbst ab.",
      );
      expectNoSecrets(output + result.stdout + result.stderr);
      expect(await Bun.file(config).exists()).toBe(false);
      const polls = state.tokens.length;
      await Bun.sleep(170);
      expect(state.tokens).toHaveLength(polls);
    });
  }

  test("SIGINT also aborts an in-flight token fetch", async () => {
    const { state, origin } = startServer([], { pending: true, tokenDelayMs: 1000 });
    const config = await configPath();
    const cli = startCli(config, userArgs(origin));
    await readUntil(cli, "Waiting for approval… (Ctrl+C cancels)");
    const deadline = Date.now() + 2000;
    while (state.tokens.length === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(state.tokens).toHaveLength(1);
    const before = Date.now();
    cli.proc.kill("SIGINT");
    const result = await finishCli(cli);
    expect(result.exitCode).toBe(130);
    expect(Date.now() - before).toBeLessThan(800);
    expect(result.stderr).toContain("Sign-in cancelled.");
    expect(await Bun.file(config).exists()).toBe(false);
  });

  test("--user help is a username and reaches discovery", async () => {
    const { state, origin } = startServer([], { hintSupported: false });
    const result = await runCli(await configPath(), ["login", "--server", origin, "--user", "help"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain("Usage:");
    expect(state.requests).toEqual(["/.well-known/oauth-authorization-server"]);
  });

  test("rejects malformed comparison-code responses before polling or storing a login", async () => {
    const authorization = { device_code: "device-code-secret", comparison: "012345", expires_in: 300, interval: 0.05 };
    for (const fields of [
      { device_code: 123 },
      { comparison: 123456 },
      { comparison: "123-456" },
      { comparison: "" },
      { expires_in: 0 },
      { interval: 0 },
    ]) {
      const { state, origin } = startServer([], { startResponse: { ...authorization, ...fields } });
      const config = await configPath();
      const result = await runCli(config, userArgs(origin));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("OAuth server returned an invalid Cloud Login authorization.");
      expect(state.tokens).toHaveLength(0);
      expect(await Bun.file(config).exists()).toBe(false);
    }
  });
});

describe("cld login --ttl", () => {
  test("plain --device keeps its requests and output while recording the server's login lifetime", async () => {
    const { state, origin } = startServer();
    const config = await configPath();
    const before = Date.now();
    const result = await runCli(config, ["login", "portal", "--server", origin, "--device", "--no-plugins"]);
    const after = Date.now();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      [
        `Open ${origin}/oauth/device and enter the code: WDJB-MJHT`,
        "Waiting for approval…",
        '✓ Signed in as Valentin Kolb (profile "portal")',
        "",
      ].join("\n"),
    );
    expect(state.requests).toEqual(["/oauth/device_authorization", "/oauth/token"]);
    expect(Object.fromEntries(state.starts[0]!)).toEqual({ client_id: "cloud-cli", scope: DEFAULT_SCOPE });
    const session = (await readConfig(config)).profiles.portal?.oauth;
    expect(session?.login).toEqual({ method: "device" });
    expectExpiry(session?.loginExpiresAt, 28800, before, after);
  });

  test("browser login sends ttl only on the code exchange and stores the capped lifetime", async () => {
    const { state, origin } = startServer([], { loginSeconds: 600 });
    const config = await configPath();
    const before = Date.now();
    const cli = startCli(config, ["login", "portal", "--server", origin, "--ttl", "8h", "--no-open", "--no-plugins"]);
    const output = await readUntil(cli, "Waiting for the OAuth callback.");
    const printed = output.match(/Login URL:\n([^\n]+)/)?.[1];
    if (!printed) throw new Error("CLI did not print a login URL.");
    const url = new URL(printed);
    expect(url.searchParams.has("ttl")).toBe(false);
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.searchParams.set("code", "test-code");
    callback.searchParams.set("state", url.searchParams.get("state")!);
    callback.searchParams.set("iss", origin);
    expect((await fetch(callback)).status).toBe(200);
    const result = await finishCli(cli);
    const after = Date.now();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(state.requests).toEqual(["/.well-known/oauth-authorization-server", "/oauth/token"]);
    expect(state.tokens[0]?.body.get("grant_type")).toBe("authorization_code");
    expect(state.tokens[0]?.body.get("ttl")).toBe("28800");
    const session = (await readConfig(config)).profiles.portal?.oauth;
    expect(session?.login).toEqual({ method: "browser", ttl: 28800 });
    expectExpiry(session?.loginExpiresAt, 600, before, after);
    expect(result.stdout).toContain(`Login expires: ${session?.loginExpiresAt}`);
  });

  test("--device sends ttl on device authorization and prints the capped expiry", async () => {
    const { state, origin } = startServer(["approve"], { loginSeconds: 600 });
    const config = await configPath();
    const before = Date.now();
    const result = await runCli(config, ["login", "portal", "--server", origin, "--device", "--ttl", "2d", "--no-plugins"]);
    const after = Date.now();
    expect(result.exitCode).toBe(0);
    expect(state.requests[0]).toBe("/.well-known/oauth-authorization-server");
    expect(state.starts[0]?.get("ttl")).toBe("172800");
    expect(state.starts[0]?.has("login_hint")).toBe(false);
    expect(state.tokens[0]?.body.has("ttl")).toBe(false);
    const session = (await readConfig(config)).profiles.portal?.oauth;
    expect(session?.login).toEqual({ method: "device", ttl: 172800 });
    expectExpiry(session?.loginExpiresAt, 600, before, after);
    expect(result.stdout).toContain(`Login expires: ${session?.loginExpiresAt}`);
  });

  for (const [value, seconds] of [
    ["90", 90],
    ["90s", 90],
    ["30m", 1800],
    ["999999999999999", 999999999999999],
  ] as const) {
    test(`normalizes valid duration ${value} to seconds`, async () => {
      const { state, origin } = startServer();
      const result = await runCli(await configPath(), [...userArgs(origin), "--ttl", value]);
      expect(result.exitCode).toBe(0);
      expect(state.starts[0]?.get("ttl")).toBe(String(seconds));
    });
  }

  for (const locale of ["en", "de"]) {
    test(`refuses missing ttl support before any login request (${locale})`, async () => {
      const { state, origin } = startServer([], { ttlSupported: false });
      for (const flags of [[], ["--device"], ["--user", "alice"]]) {
        const config = await configPath();
        const result = await runCli(config, ["--locale", locale, "login", "--server", origin, ...flags, "--ttl", "8h"]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          locale === "en"
            ? "This Cloud cannot limit a login with --ttl yet. Update Cloud, or sign in without --ttl."
            : "Diese Cloud kann eine Anmeldung noch nicht mit --ttl begrenzen. Aktualisiere Cloud oder melde dich ohne --ttl an.",
        );
        expect(await Bun.file(config).exists()).toBe(false);
      }
      expect(state.requests).toEqual(Array(3).fill("/.well-known/oauth-authorization-server"));
    });
  }

  for (const options of [{ discoveryStatus: 503 }, { discoveryJson: "invalid JSON" }]) {
    test(`reports a discovery failure as a CLI error (${JSON.stringify(options)})`, async () => {
      const { state, origin } = startServer([], options);
      const config = await configPath();
      const result = await runCli(config, userArgs(origin));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`Could not read the Cloud's OAuth discovery document (${options.discoveryStatus ?? 200}).`);
      expect(state.starts).toHaveLength(0);
      expect(await Bun.file(config).exists()).toBe(false);
    });
  }

  for (const locale of ["en", "de"]) {
    test(`invalid durations and conflicting or missing usernames fail before discovery (${locale})`, async () => {
      const { state, origin } = startServer();
      const config = await configPath();
      for (const value of ["0", "1.5", "10x", "-5", "", "1000000000000000", "999999999999999d"]) {
        const result = await runCli(config, ["--locale", locale, "login", "--server", origin, "--ttl", value]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(locale === "en" ? "Invalid --ttl" : "Ungültiges --ttl");
        expect(result.stderr).toContain("<n>s, <n>m, <n>h, <n>d");
      }
      for (const flag of ["--device", "--no-open"]) {
        const result = await runCli(config, ["--locale", locale, ...userArgs(origin), flag]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(locale === "en" ? "--user cannot be combined" : "--user kann nicht");
      }
      for (const values of [[], ["   "], ["a".repeat(255)]]) {
        const result = await runCli(config, ["--locale", locale, "login", "--server", origin, "--user", ...values]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(locale === "en" ? "--user needs" : "--user braucht");
      }
      const missingTtl = await runCli(config, ["--locale", locale, "login", "--server", origin, "--ttl"]);
      expect(missingTtl.exitCode).toBe(1);
      expect(missingTtl.stderr).toContain(locale === "en" ? "Invalid --ttl" : "Ungültiges --ttl");
      expect(state.requests).toHaveLength(0);
      expect(await Bun.file(config).exists()).toBe(false);
    });
  }
});

describe("absolute login expiry", () => {
  test("auth status shows local expiry in text and JSON, including expired and old profiles", async () => {
    // The local status remains available even when the Cloud cannot be reached.
    const origin = "http://127.0.0.1:9";
    const config = await configPath();
    for (const seconds of [3600, -60]) {
      const loginExpiresAt = new Date(Date.now() + seconds * 1000).toISOString();
      await writeSession(config, origin, { loginExpiresAt });
      for (const locale of ["en", "de"]) {
        const result = await runCli(config, ["--locale", locale, "auth", "status"]);
        expect(result.exitCode).toBe(0);
        const label =
          locale === "en" ? (seconds > 0 ? "Login expires" : "Login expired") : seconds > 0 ? "Anmeldung läuft ab" : "Anmeldung abgelaufen";
        expect(result.stdout).toContain(`${label}: ${loginExpiresAt}`);
      }
      const json = await runCli(config, ["auth", "status", "--json"]);
      expect(json.exitCode).toBe(0);
      expect(JSON.parse(json.stdout).loginExpiresAt).toBe(loginExpiresAt);
    }
    await writeSession(config, origin);
    const old = await runCli(config, ["auth", "status", "--json"]);
    expect(old.exitCode).toBe(0);
    expect(JSON.parse(old.stdout).loginExpiresAt).toBeNull();
  });

  test("expired profiles fail before using a cached access token or refreshing, with the exact re-login command", async () => {
    const { state, origin } = startServer();
    const config = await configPath();
    const login: Login = { method: "user", user: "alice@example.test", ttl: 28800, scope: "openid offline_access read" };
    for (const locale of ["en", "de"]) {
      for (const accessSeconds of [3600, -60]) {
        await writeSession(config, origin, {
          login,
          loginExpiresAt: new Date(Date.now() - 60000).toISOString(),
          accessTokenExpiresAt: new Date(Date.now() + accessSeconds * 1000).toISOString(),
        });
        const result = await runCli(config, ["--locale", locale, "plugins", "install", "--all", "--yes"]);
        expect(result.exitCode).toBe(1);
        const prefix = locale === "en" ? "Login expired, sign in again: " : "Login abgelaufen, melde dich neu an: ";
        expect(result.stderr.trim()).toBe(
          `${prefix}cld login portal --server ${origin} --user alice@example.test --ttl 8h --scope 'openid offline_access read'`,
        );
      }
    }
    expect(state.requests).toHaveLength(0);
  });

  test("re-login commands quote values and preserve fd0 references, method, ttl and scope", async () => {
    const { state, origin } = startServer();
    const config = await configPath();
    const profile = "Alice's portal";
    await writeSession(
      config,
      origin,
      {
        login: { method: "user", user: "O'Neil@example.test", ttl: 1800, scope: "openid read" },
        loginExpiresAt: new Date(Date.now() - 60000).toISOString(),
        refreshToken: undefined,
        refreshTokenFd0: { name: "cloud refresh", scope: "team's vault" },
      },
      profile,
    );
    const result = await runCli(config, ["plugins", "install", "--all", "--yes"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.trim()).toBe(
      `Login expired, sign in again: cld login 'Alice'\\''s portal' --server ${origin} --user 'O'\\''Neil@example.test' --ttl 30m --scope 'openid read' --fd0 'cloud refresh' --fd0-scope 'team'\\''s vault'`,
    );
    expect(state.requests).toHaveLength(0);
  });

  test("expired legacy metadata defaults to browser and ttl is compact in every unit", async () => {
    const { state, origin } = startServer();
    const config = await configPath();
    for (const [login, suffix] of [
      [undefined, ""],
      [{ method: "device", ttl: 172800 }, " --device --ttl 2d"],
      [{ method: "browser", ttl: 90 }, " --ttl 90s"],
    ] as const) {
      await writeSession(config, origin, { login, loginExpiresAt: new Date(Date.now() - 60000).toISOString() });
      const result = await runCli(config, ["plugins", "install", "--all", "--yes"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.trim()).toBe(`Login expired, sign in again: cld login portal --server ${origin}${suffix}`);
    }
    expect(state.requests).toHaveLength(0);
  });

  test("refresh keeps the absolute expiry and login metadata even when the server returns a different lifetime", async () => {
    const { state, origin } = startServer([], { loginSeconds: 10 });
    const config = await configPath();
    const loginExpiresAt = new Date(Date.now() + 3600_000).toISOString();
    const login: Login = { method: "user", user: "alice", ttl: 28800, scope: "openid read" };
    await writeSession(config, origin, { loginExpiresAt, login, accessTokenExpiresAt: new Date(Date.now() - 60000).toISOString() });
    const result = await runCli(config, ["plugins", "install", "--all", "--yes"]);
    expect(result.exitCode).toBe(0);
    expect(state.tokens).toHaveLength(1);
    expect(state.tokens[0]?.body.get("grant_type")).toBe("refresh_token");
    expect(state.tokens[0]?.body.has("ttl")).toBe(false);
    const session = (await readConfig(config)).profiles.portal?.oauth;
    expect(session?.accessToken).toBe("access-token-secret");
    expect(session?.refreshToken).toBe("refresh-token-secret");
    expect(session?.loginExpiresAt).toBe(loginExpiresAt);
    expect(session?.login).toEqual(login);
    const status = await runCli(config, ["auth", "status", "--json"]);
    expect(JSON.parse(status.stdout).loginExpiresAt).toBe(loginExpiresAt);
  });

  test("old profiles refresh as before without inventing an absolute login expiry", async () => {
    const { state, origin } = startServer();
    const config = await configPath();
    await writeSession(config, origin, { accessTokenExpiresAt: new Date(Date.now() - 60000).toISOString() });
    const result = await runCli(config, ["plugins", "install", "--all", "--yes"]);
    expect(result.exitCode).toBe(0);
    expect(state.tokens).toHaveLength(1);
    expect((await readConfig(config)).profiles.portal?.oauth.loginExpiresAt).toBeUndefined();
    const status = await runCli(config, ["auth", "status", "--json"]);
    expect(JSON.parse(status.stdout).loginExpiresAt).toBeNull();
  });

  test("a forced refresh after 401 rereads and checks absolute expiry", async () => {
    const config = await configPath();
    const { state, origin } = startServer([], {
      onPlugins: async () => {
        const stored = await readConfig(config);
        stored.profiles.portal!.oauth.loginExpiresAt = new Date(Date.now() - 60000).toISOString();
        await writeFile(config, JSON.stringify(stored));
        return Response.json({ error: "unauthorized" }, { status: 401 });
      },
    });
    await writeSession(config, origin, {
      login: { method: "user", user: "alice", ttl: 28800 },
      loginExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const result = await runCli(config, ["plugins", "install", "--all", "--yes"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Login expired, sign in again: cld login portal --server ${origin} --user alice --ttl 8h`);
    expect(state.requests).toEqual(["/cli/plugins"]);
    expect(state.tokens).toHaveLength(0);
  });

  test("omitted refresh-token lifetime stays absent on login and invalid values fail validation", async () => {
    const token = { access_token: "access-token-secret", token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-token-secret" };
    const supported = startServer(["approve"], { tokenResponse: token });
    const config = await configPath();
    const result = await runCli(config, userArgs(supported.origin));
    expect(result.exitCode).toBe(0);
    expect((await readConfig(config)).profiles.portal?.oauth.loginExpiresAt).toBeUndefined();
    expect(result.stdout).not.toContain("Login expires:");
    for (const value of ["28800", -1, 1.5, null, true]) {
      const { origin } = startServer(["approve"], { tokenResponse: { ...token, refresh_token_expires_in: value } });
      const config = await configPath();
      const result = await runCli(config, userArgs(origin));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("OAuth server returned an invalid refresh token lifetime.");
      expect(await Bun.file(config).exists()).toBe(false);
    }
  });

  test("an omitted refresh-token lifetime with --ttl still ends the login no later than ttl", async () => {
    const token = { access_token: "access-token-secret", token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-token-secret" };
    const { origin } = startServer(["approve", "approve"], { tokenResponse: token });
    const config = await configPath();
    const before = Date.now();
    const result = await runCli(config, [...userArgs(origin), "--ttl", "30m"]);
    const after = Date.now();
    expect(result.exitCode).toBe(0);
    const session = (await readConfig(config)).profiles.portal?.oauth;
    expectExpiry(session?.loginExpiresAt, 1800, before, after);
    expect(result.stdout).toContain(`Login expires: ${session?.loginExpiresAt}`);

    // The longest accepted ttl must not break the date: no Cloud login outlives 90 days.
    const longest = await configPath();
    const start = Date.now();
    const capped = await runCli(longest, [...userArgs(origin), "--ttl", "999999999999999"]);
    const end = Date.now();
    expect(capped.exitCode).toBe(0);
    expectExpiry((await readConfig(longest)).profiles.portal?.oauth.loginExpiresAt, 90 * 86400, start, end);
  });

  test("login refuses a profile with an agent's client credentials before any request", async () => {
    const { state, origin } = startServer();
    const config = await configPath();
    const agentConfig = JSON.stringify({
      currentProfile: "agent",
      profiles: { agent: { server: origin, clientCredentials: { clientId: "agent-1", clientSecret: "agent-secret" } } },
    });
    await writeFile(config, agentConfig);
    for (const [locale, expected] of [
      ["en", 'Profile "agent" holds an agent\'s client credentials. Run `cld logout --profile agent` first'],
      ["de", 'Profil "agent" enthält die Client-Zugangsdaten eines Agents. Führe zuerst `cld logout --profile agent` aus'],
    ] as const) {
      const result = await runCli(config, ["--locale", locale, "login", "agent", "--server", origin, "--user", "alice", "--ttl", "8h"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(expected);
    }
    expect(state.requests).toHaveLength(0);
    expect(await readFile(config, "utf8")).toBe(agentConfig);
  });
});

test("login and auth help document Cloud Login and login expiry in English and German", async () => {
  const config = await configPath();
  for (const locale of ["en", "de"]) {
    const result = await runCli(config, ["--locale", locale, "login", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(locale === "en" ? "--user <name>" : "--user <Name>");
    expect(result.stdout).toContain(locale === "en" ? "--ttl <duration>" : "--ttl <Dauer>");
    expect(result.stdout).toContain("cld login portal --server https://cloud.example --user alice --ttl 8h");
    expect(result.stdout).toContain(locale === "en" ? "90 days" : "90 Tage");
    expect(result.stdout).toContain(locale === "en" ? "Cloud's session length" : "Sitzungslänge der Cloud");
    const auth = await runCli(config, ["--locale", locale, "auth", "--help"]);
    expect(auth.exitCode).toBe(0);
    expect(auth.stdout).toContain(locale === "en" ? "login expire" : "Anmeldung ablaufen");
  }
});
