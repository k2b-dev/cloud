import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

type MockServerState = {
  refreshCalls: number;
  authorizationCodeCalls?: number;
  revokeCalls: number;
  revokedTokens?: string[];
  meCalls: number;
  failFirstMe?: boolean;
  tokenResponse?: unknown;
  tokenDelayMs?: number;
  appsCalls?: number;
  appsSearch?: string | null;
  capabilityCatalog?: unknown;
  acceptLanguages?: string[];
};

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cld-cli-test-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const testUser = {
  id: "user-id",
  uid: "tester",
  provider: "local",
  profile: "user",
  roles: ["user"],
  givenname: "Test",
  sn: "User",
  displayName: "Test User",
  mail: "test@example.test",
  memberofGroup: [],
  manages: [],
  accountExpires: null,
  lastLoginLocal: null,
  ipa: null,
};

const startMockServer = (state: MockServerState) =>
  Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      state.acceptLanguages ??= [];
      state.acceptLanguages.push(request.headers.get("accept-language") ?? "");
      if (url.pathname === "/oauth/token") {
        if (state.tokenDelayMs) await Bun.sleep(state.tokenDelayMs);
        const body = await request.formData();
        const grantType = body.get("grant_type");
        if (grantType === "authorization_code") {
          state.authorizationCodeCalls = (state.authorizationCodeCalls ?? 0) + 1;
          expect(body.get("code")).toBe("test-code");
          expect(body.get("client_id")).toBe("cloud-cli");
          expect(body.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
        } else {
          state.refreshCalls += 1;
          expect(grantType).toBe("refresh_token");
          expect(body.get("client_id")).toBe("cloud-cli");
        }
        return Response.json(
          state.tokenResponse ?? {
            access_token: grantType === "authorization_code" ? "login-access" : "new-access",
            token_type: "Bearer",
            expires_in: 3600,
            id_token: null,
            scope: "openid",
            refresh_token: grantType === "authorization_code" ? "login-refresh" : "new-refresh",
          },
        );
      }

      if (url.pathname === "/oauth/revoke") {
        state.revokeCalls += 1;
        const body = await request.formData();
        expect(body.get("client_id")).toBe("cloud-cli");
        state.revokedTokens ??= [];
        state.revokedTokens.push(String(body.get("token")));
        return new Response(null, { status: 200 });
      }

      if (url.pathname === "/api/me") {
        state.meCalls += 1;
        if (state.failFirstMe && state.meCalls === 1) {
          return Response.json({ message: "expired" }, { status: 401 });
        }
        return Response.json(testUser);
      }

      if (url.pathname === "/api/apps") {
        state.appsCalls = (state.appsCalls ?? 0) + 1;
        state.appsSearch = url.searchParams.get("search");
        return Response.json({
          items: [
            {
              id: "contacts",
              name: "Contacts",
              description: "Contact books and people.",
              icon: "ti ti-address-book",
              href: "/app/contacts",
            },
          ],
        });
      }

      if (url.pathname === "/api/capabilities/v1/catalog" && state.capabilityCatalog) {
        return Response.json(state.capabilityCatalog);
      }

      return Response.json({ message: "not found" }, { status: 404 });
    },
  });

const startCli = (configPath: string, args: string[], extraEnv: Record<string, string> = {}) =>
  Bun.spawn({
    cmd: [process.execPath, "run", "packages/cloud-cli/src/index.ts", ...args],
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv, CLD_CONFIG: configPath },
    stdout: "pipe",
    stderr: "pipe",
  });

const writeConfig = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
};

const runCli = async (configPath: string, args: string[], extraEnv: Record<string, string> = {}) => {
  const proc = startCli(configPath, args, extraEnv);
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode, stdout, stderr };
};

const readUntil = async (stream: ReadableStream<Uint8Array>, marker: string): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";

  while (!text.includes(marker)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }

  reader.releaseLock();
  return text;
};

describe("cloud CLI OAuth session handling", () => {
  test("selects localized human help explicitly without changing command syntax", async () => {
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");

    const [english, german] = await Promise.all([runCli(configPath, ["help"]), runCli(configPath, ["--locale", "de-CH", "help"])]);

    expect(english.exitCode).toBe(0);
    expect(english.stdout).toContain("Usage:");
    expect(german.exitCode).toBe(0);
    expect(german.stdout).toContain("Verwendung:");
    expect(german.stdout).toContain("--jsonl");
    expect(german.stdout).toContain("notebooks list");
  });

  test("uses CLD_LOCALE only when no explicit locale is present", async () => {
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");

    const [fromEnvironment, explicit] = await Promise.all([
      runCli(configPath, ["help"], { CLD_LOCALE: "de" }),
      runCli(configPath, ["--locale", "en", "help"], { CLD_LOCALE: "de" }),
    ]);

    expect(fromEnvironment.stdout).toContain("Verwendung:");
    expect(explicit.stdout).toContain("Usage:");
  });

  test("prints its version without requiring a configured server", async () => {
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");

    const result = await runCli(configPath, ["--version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^cld 0\.0\.0-dev \(unknown\)\n$/);
  });

  test("prints compact JSON errors in JSON Lines mode", async () => {
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");

    const result = await runCli(configPath, ["--locale", "de-CH", "--jsonl", "missing-module"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stderr)).toEqual({
      error: { message: 'Unknown module "missing-module". Run `cld help`.', exitCode: 1 },
    });
  });

  test("localizes text errors without translating their JSON contract", async () => {
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");

    const result = await runCli(configPath, ["--locale", "de-CH", "missing-module"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('Unbekanntes Modul "missing-module"');
  });

  test("rejects incomplete update versions before contacting a release server", async () => {
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");

    const result = await runCli(configPath, ["update", "--version"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--version requires a value.");
  });

  test("top-level help includes the built-in app modules", async () => {
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");

    const result = await runCli(configPath, ["help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("assistant");
    expect(result.stdout).toContain("Chat with the Cloud Assistant");
    expect(result.stdout).toContain("grids");
    expect(result.stdout).toContain("Manage Grids bases");
    expect(result.stdout).toContain("mail");
    expect(result.stdout).toContain("Search, read, configure, and operate Cloud Mail");
  });

  test("nested module help does not require a configured server", async () => {
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");

    const result = await runCli(configPath, ["notebooks", "access", "grant", "help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("cld notebooks access grant");
    expect(result.stdout).toContain("--permission <value>");
  });

  test("app command groups use domain-specific help summaries", async () => {
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");
    const [accounts, grids, mail, tools] = await Promise.all([
      runCli(configPath, ["accounts", "help"]),
      runCli(configPath, ["grids", "apps", "help"]),
      runCli(configPath, ["mail", "admin", "security", "help"]),
      runCli(configPath, ["tools", "help"]),
    ]);

    for (const result of [accounts, grids, mail, tools]) {
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toMatch(/^\s+\S+\s+Commands$/m);
    }
    expect(accounts.stdout).toContain("groups         Create, inspect, and manage groups");
    expect(grids.stdout).toMatch(/apply\s+Create or update an App draft from its definition/);
    expect(mail.stdout).toContain("identity       Manage protected sender identities");
    expect(tools.stdout).toContain("password       Generate passwords and estimate password strength");
  });

  test("Pulse access help uses the shared offline access command shape", async () => {
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");

    const result = await runCli(configPath, ["pulse", "access", "grant", "help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("cld pulse access grant");
    expect(result.stdout).toContain("--permission <value>");
  });

  test("runs one offline command inside the Cloud-backed Grids module without a profile", async () => {
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");
    const missingPackage = join(dir, "missing.tar");

    const result = await runCli(configPath, ["--json", "grids", "evidence", "verify", missingPackage]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    const payload = JSON.parse(result.stderr) as { error: { message: string } };
    expect(payload.error.message).toContain("missing.tar");
    expect(payload.error.message).not.toContain("No server configured");
  });

  test("lists apps visible to the current profile", async () => {
    const state: MockServerState = { refreshCalls: 0, revokeCalls: 0, meCalls: 0 };
    const server = startMockServer(state);
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");

    try {
      await writeConfig(configPath, {
        currentProfile: "default",
        profiles: { default: { server: `http://127.0.0.1:${server.port}`, token: "cld_test" } },
      });

      const result = await runCli(configPath, ["apps", "list", "--search", "contacts", "--json"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(state.appsCalls).toBe(1);
      expect(state.appsSearch).toBe("contacts");
      expect(JSON.parse(result.stdout)).toEqual({
        items: [
          {
            id: "contacts",
            name: "Contacts",
            description: "Contact books and people.",
            icon: "ti ti-address-book",
            href: "/app/contacts",
          },
        ],
      });
    } finally {
      server.stop(true);
    }
  });

  test("passes OAuth client pagination and search to the bounded admin API", async () => {
    let receivedQuery: URLSearchParams | null = null;
    const client = {
      id: crypto.randomUUID(),
      name: "Codex",
      description: "MCP client",
      clientId: "codex-client",
      redirectUris: ["https://client.example.test/callback"],
      logoutUri: null,
      scopes: ["read"],
      audiences: ["cloud"],
      serviceAccountId: null,
      allowedProfiles: ["user"],
      accessMode: "profiles",
      accessUsers: [],
      accessGroups: [],
      registrationKind: "managed",
      isPublic: true,
      createdAt: new Date().toISOString(),
      createdBy: null,
    };
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        receivedQuery = url.searchParams;
        return Response.json({
          clients: [client],
          pagination: { page: 2, per_page: 3, total: 4, total_pages: 2, has_next: false },
        });
      },
    });
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");

    try {
      await writeConfig(configPath, {
        currentProfile: "default",
        profiles: { default: { server: `http://127.0.0.1:${server.port}`, token: "cld_test" } },
      });

      const result = await runCli(configPath, [
        "oauth",
        "clients",
        "list",
        "--page",
        "2",
        "--per-page",
        "3",
        "--search",
        "codex",
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(Object.fromEntries(receivedQuery!)).toEqual({ page: "2", per_page: "3", search: "codex" });
      expect(JSON.parse(result.stdout)).toEqual([client]);

      const resolved = await runCli(configPath, ["oauth", "clients", "get", "Codex", "--json"]);
      expect(resolved.exitCode).toBe(0);
      expect(JSON.parse(resolved.stdout)).toEqual(client);
      expect(Object.fromEntries(receivedQuery!)).toEqual({ page: "1", per_page: "100", search: "Codex" });
    } finally {
      server.stop(true);
    }
  });

  test("forwards capability protocol headers alongside authentication", async () => {
    const receivedHeaders: Array<{ authorization: string | null; idempotencyKey: string | null }> = [];
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        receivedHeaders.push({
          authorization: request.headers.get("authorization"),
          idempotencyKey: request.headers.get("idempotency-key"),
        });
        return Response.json({ data: { ok: true } });
      },
    });
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");

    try {
      await writeConfig(configPath, {
        currentProfile: "default",
        profiles: { default: { server: `http://127.0.0.1:${server.port}`, token: "cld_test" } },
      });

      const result = await runCli(configPath, [
        "--json",
        "capabilities",
        "action",
        "contacts",
        "create",
        "--input",
        '{"bookId":"book-1","label":"Ada"}',
        "--idempotency-key",
        "contact-ada",
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(receivedHeaders).toEqual([{ authorization: "Bearer cld_test", idempotencyKey: "contact-ada" }]);
    } finally {
      server.stop(true);
    }
  });

  test("flushes a capability catalog larger than the stdout pipe buffer", async () => {
    const description = "Capability description ".repeat(35);
    const queries = Array.from({ length: 100 }, (_, index) => ({
      localId: `query${index}`,
      title: `Query ${index}`,
      description,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      dataSchema: { type: "array", items: { type: "string" } },
      schemaHash: "0".repeat(64),
      openWorld: false,
    }));
    const catalog = {
      protocolVersion: 1,
      apps: [
        {
          appId: "large",
          appName: "Large",
          appIcon: "ti ti-box",
          appDescription: "Large capability catalog fixture.",
          manifest: {
            protocolVersion: 1,
            appId: "large",
            manifestHash: "1".repeat(64),
            types: [],
            queries,
            actions: [],
          },
        },
      ],
      page: { hasMore: false },
    };
    const state: MockServerState = {
      refreshCalls: 0,
      revokeCalls: 0,
      meCalls: 0,
      capabilityCatalog: catalog,
    };
    const server = startMockServer(state);
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");

    try {
      await writeConfig(configPath, {
        currentProfile: "default",
        profiles: { default: { server: `http://127.0.0.1:${server.port}`, token: "cld_test" } },
      });

      const result = await runCli(configPath, ["capabilities", "catalog", "--limit", "1", "--json"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(new TextEncoder().encode(result.stdout).byteLength).toBeGreaterThan(64 * 1024);
      expect(JSON.parse(result.stdout)).toEqual(catalog);
    } finally {
      server.stop(true);
    }
  });

  test("login callback returns a plain-text completion message", async () => {
    const state: MockServerState = { refreshCalls: 0, authorizationCodeCalls: 0, revokeCalls: 0, meCalls: 0 };
    const server = startMockServer(state);
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");

    try {
      await writeConfig(configPath, {
        currentProfile: "local",
        profiles: {
          local: {
            server: `http://127.0.0.1:${server.port}`,
            oauth: {
              accessToken: "old-access",
              accessTokenExpiresAt: "2000-01-01T00:00:00.000Z",
              refreshToken: "old-refresh",
              scope: "openid",
            },
          },
        },
      });
      const proc = startCli(configPath, ["login", "local", "--server", `http://127.0.0.1:${server.port}`, "--no-open"]);
      const stderrPromise = new Response(proc.stderr).text();
      const stdout = await readUntil(proc.stdout, "Waiting for the OAuth callback.");
      const loginUrlMatch = stdout.match(/Login URL:\n(?<url>http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize[^\n]+)/);
      const printedLoginUrl = loginUrlMatch?.groups?.url;
      expect(printedLoginUrl).toBeString();
      if (!printedLoginUrl) throw new Error("CLI did not print a login URL.");

      const loginUrl = new URL(printedLoginUrl);
      expect(loginUrl.searchParams.get("client_id")).toBe("cloud-cli");
      const redirectUri = loginUrl.searchParams.get("redirect_uri");
      const stateParam = loginUrl.searchParams.get("state");
      expect(redirectUri).toBeString();
      expect(stateParam).toBeString();

      const callbackUrl = new URL(redirectUri!);
      callbackUrl.searchParams.set("error", "access_denied");
      callbackUrl.searchParams.set("state", "wrong-state");
      const unrelatedCallback = await fetch(callbackUrl);
      expect(unrelatedCallback.status).toBe(400);

      callbackUrl.searchParams.delete("error");
      callbackUrl.searchParams.set("code", "test-code");
      callbackUrl.searchParams.set("state", stateParam!);
      callbackUrl.searchParams.set("iss", `http://127.0.0.1:${server.port}`);
      const callbackResponse = await fetch(callbackUrl);
      const callbackText = await callbackResponse.text();

      expect(callbackResponse.status).toBe(200);
      expect(callbackResponse.headers.get("content-type")).toContain("text/plain");
      expect(callbackText).toBe("Authentication complete. You may close this window.\n");

      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
      expect(await stderrPromise).toBe("");
      expect(state.authorizationCodeCalls).toBe(1);
      expect(state.revokedTokens).toEqual(["old-refresh"]);

      const config = JSON.parse(await readFile(configPath, "utf8")) as {
        currentProfile: string;
        profiles: { local: { oauth: { accessToken: string; refreshToken: string } } };
      };
      expect(config.currentProfile).toBe("local");
      expect(config.profiles.local.oauth.accessToken).toBe("login-access");
      expect(config.profiles.local.oauth.refreshToken).toBe("login-refresh");
      expect("clientId" in config.profiles.local.oauth).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("rejects overriding the first-party OAuth client", async () => {
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");
    await writeConfig(configPath, {});

    const result = await runCli(configPath, ["login", "--client-id", "custom-client"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("always uses the first-party");
  });

  test("rejects stored OAuth credentials when the effective server changes", async () => {
    let receivedRequests = 0;
    const foreignServer = Bun.serve({
      port: 0,
      fetch: () => {
        receivedRequests += 1;
        return Response.json(testUser);
      },
    });
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");

    try {
      for (const mode of ["fresh", "expired"] as const) {
        await writeConfig(configPath, {
          currentProfile: "default",
          profiles: {
            default: {
              server: "https://cloud.example.test",
              oauth: {
                accessToken: "secret-access",
                accessTokenExpiresAt: mode === "fresh" ? new Date(Date.now() + 3_600_000).toISOString() : "2000-01-01T00:00:00.000Z",
                refreshToken: "secret-refresh",
                scope: "openid",
              },
            },
          },
        });

        const override = `http://127.0.0.1:${foreignServer.port}`;
        const result =
          mode === "fresh"
            ? await runCli(configPath, ["--server", override, "account", "whoami", "--json"])
            : await runCli(configPath, ["account", "whoami", "--json"], { CLD_SERVER: override });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("is bound to https://cloud.example.test");
      }
      const profileSet = await runCli(configPath, ["profile", "set", "default", "--server", `http://127.0.0.1:${foreignServer.port}`]);
      expect(profileSet.exitCode).toBe(1);
      const stored = JSON.parse(await readFile(configPath, "utf8")) as { profiles: { default: { server: string } } };
      expect(stored.profiles.default.server).toBe("https://cloud.example.test");
      expect(receivedRequests).toBe(0);
    } finally {
      foreignServer.stop(true);
    }
  }, 15_000);

  test("accepts only pathless HTTP or HTTPS server origins", async () => {
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");
    await writeConfig(configPath, {});

    for (const [index, server] of [
      "ftp://cloud.example.test",
      "https://user:secret@cloud.example.test",
      "https://cloud.example.test/path",
      "https://cloud.example.test?query=yes",
      "https://cloud.example.test#fragment",
    ].entries()) {
      const result = await runCli(configPath, ["profile", "set", `invalid-${index}`, "--server", server, "--token", "token"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("HTTP(S) origin");
    }
  }, 30_000);

  test("allows plaintext Cloud servers only on exact loopback hosts", async () => {
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");
    await writeConfig(configPath, {});

    for (const [index, server] of ["http://cloud.example.test", "http://127.0.0.2:3000", "http://[::2]:3000"].entries()) {
      const result = await runCli(configPath, ["profile", "set", `remote-${index}`, "--server", server, "--token", "token"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("must use HTTPS");
    }

    for (const [index, server] of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"].entries()) {
      const result = await runCli(configPath, ["profile", "set", `loopback-${index}`, "--server", server, "--token", "token"]);
      expect(result.exitCode).toBe(0);
    }
  }, 30_000);

  test("revokes a displaced OAuth grant when profile set changes credential providers", async () => {
    const state: MockServerState = { refreshCalls: 0, revokeCalls: 0, meCalls: 0 };
    const server = startMockServer(state);
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");

    try {
      await writeConfig(configPath, {
        currentProfile: "default",
        profiles: {
          default: {
            server: `http://127.0.0.1:${server.port}`,
            oauth: {
              accessToken: "old-access",
              accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              refreshToken: "old-refresh",
            },
          },
        },
      });

      const result = await runCli(configPath, ["profile", "set", "default", "--token", "static-token"]);
      expect(result.exitCode).toBe(0);
      expect(state.revokedTokens).toEqual(["old-refresh"]);
      const stored = JSON.parse(await readFile(configPath, "utf8")) as {
        profiles: { default: { token: string; oauth?: unknown } };
      };
      expect(stored.profiles.default.token).toBe("static-token");
      expect(stored.profiles.default.oauth).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("rejects a callback with the wrong issuer before exchanging a code", async () => {
    const state: MockServerState = { refreshCalls: 0, authorizationCodeCalls: 0, revokeCalls: 0, meCalls: 0 };
    const server = startMockServer(state);
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");

    try {
      const proc = startCli(configPath, ["login", "local", "--server", `http://127.0.0.1:${server.port}`, "--no-open"]);
      const stderrPromise = new Response(proc.stderr).text();
      const stdout = await readUntil(proc.stdout, "Waiting for the OAuth callback.");
      const printedLoginUrl = stdout.match(/Login URL:\n(?<url>http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize[^\n]+)/)?.groups?.url;
      if (!printedLoginUrl) throw new Error("CLI did not print a login URL.");
      const loginUrl = new URL(printedLoginUrl);
      const callbackUrl = new URL(loginUrl.searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "test-code");
      callbackUrl.searchParams.set("state", loginUrl.searchParams.get("state")!);
      callbackUrl.searchParams.set("iss", "https://other.example.test");

      expect((await fetch(callbackUrl)).status).toBe(400);
      expect(await proc.exited).toBe(1);
      expect(await stderrPromise).toContain("expected issuer");
      expect(state.authorizationCodeCalls).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("revokes a newly issued refresh token when login persistence fails", async () => {
    const state: MockServerState = { refreshCalls: 0, authorizationCodeCalls: 0, revokeCalls: 0, meCalls: 0 };
    const server = startMockServer(state);
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");

    try {
      await writeConfig(configPath, {});
      const proc = startCli(configPath, ["login", "local", "--server", `http://127.0.0.1:${server.port}`, "--no-open"]);
      const stderrPromise = new Response(proc.stderr).text();
      const stdout = await readUntil(proc.stdout, "Waiting for the OAuth callback.");
      const printedLoginUrl = stdout.match(/Login URL:\n(?<url>http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize[^\n]+)/)?.groups?.url;
      if (!printedLoginUrl) throw new Error("CLI did not print a login URL.");
      const loginUrl = new URL(printedLoginUrl);
      const callbackUrl = new URL(loginUrl.searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "test-code");
      callbackUrl.searchParams.set("state", loginUrl.searchParams.get("state")!);
      callbackUrl.searchParams.set("iss", `http://127.0.0.1:${server.port}`);

      await rm(configPath);
      await mkdir(configPath);
      expect((await fetch(callbackUrl)).status).toBe(200);
      expect(await proc.exited).toBe(1);
      expect(await stderrPromise).not.toBe("");
      expect(state.revokedTokens).toEqual(["login-refresh"]);
    } finally {
      server.stop(true);
    }
  });

  test("validates OAuth token responses before persisting them", async () => {
    const state: MockServerState = {
      refreshCalls: 0,
      revokeCalls: 0,
      meCalls: 0,
      tokenResponse: {
        access_token: "new-access",
        token_type: "Bearer",
        expires_in: "3600",
        refresh_token: "new-refresh",
      },
    };
    const server = startMockServer(state);
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");

    try {
      await writeConfig(configPath, {
        currentProfile: "default",
        profiles: {
          default: {
            server: `http://127.0.0.1:${server.port}`,
            oauth: {
              accessToken: "old-access",
              accessTokenExpiresAt: "2000-01-01T00:00:00.000Z",
              refreshToken: "old-refresh",
              scope: "openid",
            },
          },
        },
      });

      const result = await runCli(configPath, ["account", "whoami", "--json"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid token lifetime");
      expect(state.meCalls).toBe(0);
      const stored = JSON.parse(await readFile(configPath, "utf8")) as {
        profiles: { default: { oauth: { refreshToken: string } } };
      };
      expect(stored.profiles.default.oauth.refreshToken).toBe("old-refresh");
    } finally {
      server.stop(true);
    }
  });

  test("does not follow redirects for refresh-token requests", async () => {
    let redirectedRequests = 0;
    const redirectTarget = Bun.serve({
      port: 0,
      fetch: () => {
        redirectedRequests += 1;
        return Response.json({});
      },
    });
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.redirect(`http://127.0.0.1:${redirectTarget.port}/capture`, 307),
    });
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");

    try {
      await writeConfig(configPath, {
        currentProfile: "default",
        profiles: {
          default: {
            server: `http://127.0.0.1:${server.port}`,
            oauth: {
              accessToken: "old-access",
              accessTokenExpiresAt: "2000-01-01T00:00:00.000Z",
              refreshToken: "secret-refresh",
            },
          },
        },
      });

      expect((await runCli(configPath, ["account", "whoami", "--json"])).exitCode).toBe(1);
      expect(redirectedRequests).toBe(0);
    } finally {
      server.stop(true);
      redirectTarget.stop(true);
    }
  });

  test("refresh recovers a stale config lock and persists the rotated token", async () => {
    const state: MockServerState = { refreshCalls: 0, revokeCalls: 0, meCalls: 0 };
    const server = startMockServer(state);
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");
    const lockPath = join(dir, "locks", "config.lock");

    try {
      await writeConfig(configPath, {
        currentProfile: "default",
        profiles: {
          default: {
            server: `http://127.0.0.1:${server.port}`,
            oauth: {
              accessToken: "old-access",
              accessTokenExpiresAt: "2000-01-01T00:00:00.000Z",
              refreshToken: "old-refresh",
              scope: "openid",
            },
          },
        },
      });
      await mkdir(lockPath, { recursive: true });
      await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: 999_999_999, createdAt: Date.now() }), { mode: 0o600 });

      const result = await runCli(configPath, ["account", "whoami", "--json"]);
      expect(result.exitCode).toBe(0);
      expect(state.refreshCalls).toBe(1);
      expect(state.revokeCalls).toBe(0);

      const config = JSON.parse(await readFile(configPath, "utf8")) as {
        profiles: { default: { oauth: { accessToken: string; refreshToken: string } } };
      };
      expect(config.profiles.default.oauth.accessToken).toBe("new-access");
      expect(config.profiles.default.oauth.refreshToken).toBe("new-refresh");
    } finally {
      server.stop(true);
    }
  });

  test("serializes refresh writes across different profiles", async () => {
    const state: MockServerState = { refreshCalls: 0, revokeCalls: 0, meCalls: 0, tokenDelayMs: 50 };
    const server = startMockServer(state);
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");
    const profile = (refreshToken: string) => ({
      server: `http://127.0.0.1:${server.port}`,
      oauth: {
        accessToken: "old-access",
        accessTokenExpiresAt: "2000-01-01T00:00:00.000Z",
        refreshToken,
      },
    });

    try {
      await writeConfig(configPath, {
        currentProfile: "one",
        profiles: { one: profile("refresh-one"), two: profile("refresh-two") },
      });

      const [one, two] = await Promise.all([
        runCli(configPath, ["--profile", "one", "account", "whoami", "--json"]),
        runCli(configPath, ["--profile", "two", "account", "whoami", "--json"]),
      ]);
      expect(one.exitCode).toBe(0);
      expect(two.exitCode).toBe(0);
      expect(state.refreshCalls).toBe(2);
      const stored = JSON.parse(await readFile(configPath, "utf8")) as {
        profiles: { one: { oauth: { accessToken: string } }; two: { oauth: { accessToken: string } } };
      };
      expect(stored.profiles.one.oauth.accessToken).toBe("new-access");
      expect(stored.profiles.two.oauth.accessToken).toBe("new-access");
    } finally {
      server.stop(true);
    }
  });

  test("401 responses refresh once and retry with the new access token", async () => {
    const state: MockServerState = { refreshCalls: 0, revokeCalls: 0, meCalls: 0, failFirstMe: true };
    const server = startMockServer(state);
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");

    try {
      await writeConfig(configPath, {
        currentProfile: "default",
        profiles: {
          default: {
            server: `http://127.0.0.1:${server.port}`,
            oauth: {
              accessToken: "stale-access",
              accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
              refreshToken: "old-refresh",
              scope: "openid",
            },
          },
        },
      });

      const result = await runCli(configPath, ["account", "whoami", "--json"]);
      expect(result.exitCode).toBe(0);
      expect(state.meCalls).toBe(2);
      expect(state.refreshCalls).toBe(1);
      expect(state.acceptLanguages).toContain("en");
      expect(result.stdout).toContain("tester");
    } finally {
      server.stop(true);
    }
  });

  test("forwards an explicit regional locale while keeping JSON fields unchanged", async () => {
    const state: MockServerState = { refreshCalls: 0, revokeCalls: 0, meCalls: 0 };
    const server = startMockServer(state);
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");

    try {
      const result = await runCli(configPath, [
        "--server",
        `http://127.0.0.1:${server.port}`,
        "--token",
        "test-token",
        "--locale",
        "de-CH",
        "account",
        "whoami",
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).uid).toBe("tester");
      expect(state.acceptLanguages).toContain("de-CH");
    } finally {
      server.stop(true);
    }
  });

  test("failed fd0 refresh-token persistence revokes the new token and removes the local OAuth session", async () => {
    const state: MockServerState = { refreshCalls: 0, revokeCalls: 0, meCalls: 0 };
    const server = startMockServer(state);
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");
    const binDir = join(dir, "bin");
    const fd0Path = join(binDir, "fd0");

    try {
      await mkdir(binDir, { recursive: true });
      await writeFile(
        fd0Path,
        `#!/bin/sh
if [ "$1" = "get" ]; then
  printf '%s\n' old-refresh
  exit 0
fi
if [ "$1" = "set" ]; then
  echo "fd0 write failed" >&2
  exit 1
fi
exit 0
`,
        { mode: 0o700 },
      );
      await chmod(fd0Path, 0o700);
      await writeConfig(configPath, {
        currentProfile: "default",
        profiles: {
          default: {
            server: `http://127.0.0.1:${server.port}`,
            oauth: {
              accessToken: "old-access",
              accessTokenExpiresAt: "2000-01-01T00:00:00.000Z",
              refreshTokenFd0: { name: "cloud-default-oauth-refresh-token" },
              scope: "openid",
            },
          },
        },
      });

      const result = await runCli(configPath, ["account", "whoami", "--json"], { PATH: `${binDir}:${process.env.PATH ?? ""}` });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("fd0 write failed");
      expect(state.refreshCalls).toBe(1);
      expect(state.revokeCalls).toBe(1);

      const config = JSON.parse(await readFile(configPath, "utf8")) as { profiles: { default: { oauth?: unknown } } };
      expect(config.profiles.default.oauth).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("removes fd0 refresh tokens non-interactively during logout", async () => {
    const state: MockServerState = { refreshCalls: 0, revokeCalls: 0, meCalls: 0 };
    const server = startMockServer(state);
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");
    const argsPath = join(dir, "fd0-args.txt");
    const binDir = join(dir, "bin");
    const fd0Path = join(binDir, "fd0");

    try {
      await mkdir(binDir, { recursive: true });
      await writeFile(
        fd0Path,
        `#!/bin/sh
if [ "$1" = "get" ]; then
  printf '%s\n' old-refresh
  exit 0
fi
if [ "$1" = "rm" ]; then
  printf '%s\n' "$@" > "$FD0_ARGS_PATH"
  [ "$3" = "--yes" ]
  exit $?
fi
exit 1
`,
        { mode: 0o700 },
      );
      await chmod(fd0Path, 0o700);
      await writeConfig(configPath, {
        currentProfile: "default",
        profiles: {
          default: {
            server: `http://127.0.0.1:${server.port}`,
            oauth: {
              accessToken: "access",
              accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              refreshTokenFd0: { name: "cloud-default-oauth-refresh-token", scope: "test" },
            },
          },
        },
      });

      const result = await runCli(configPath, ["logout"], {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        FD0_ARGS_PATH: argsPath,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect((await readFile(argsPath, "utf8")).trim().split("\n")).toEqual([
        "rm",
        "cloud-default-oauth-refresh-token",
        "--yes",
        "--scope",
        "test",
      ]);
      expect(state.revokedTokens).toEqual(["old-refresh"]);
    } finally {
      server.stop(true);
    }
  });

  test("prints JSON errors when --json is requested", async () => {
    const dir = await createTempDir();
    const configPath = join(dir, "config.json");

    const result = await runCli(configPath, ["--json", "admin", "status"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");

    const payload = JSON.parse(result.stderr) as { error: { message: string; exitCode: number } };
    expect(payload.error.message).toContain("No server configured");
    expect(payload.error.exitCode).toBe(1);
  });
});
