#!/usr/bin/env bun
import { exec, execFile, spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import type {
  CloudCliClientCredentialsProfile,
  CloudCliContext,
  CloudCliFlags,
  CloudCliFlagValue,
  CloudCliModule,
  CloudCliOptions,
  CloudCliPluginSummary,
  CloudCliTableColumn,
} from "@k2b/cloud/cli";
import { CLOUD_CLI_MODULE_NAME, localizeCloudCliText, resolveCloudCliLocale } from "@k2b/cloud/cli";
import type { Hono } from "hono";
import { hc } from "hono/client";
import { configPath, envLacksLocalBrowser, envLocale, envServer, envToken } from "./config";
import {
  collectPluginGarbage,
  downloadPlugin,
  fetchAvailablePlugins,
  fetchPluginManifest,
  hasStoredPlugin,
  type LockedPlugin,
  loadStoredPlugin,
  type PluginLock,
  placePlugin,
  readPluginLock,
  readStoredReference,
} from "./plugin-store";
import {
  commitPlugin,
  isPackagePluginSource,
  loadPlugin,
  loadPlugins,
  PluginError,
  type PluginInfo,
  pluginsDirectory,
  removePlugin,
  stagePlugin,
} from "./plugins";
import { updateCli } from "./release";
import {
  CLAUDE_SKILL_TARGET,
  DEFAULT_SKILL_TARGET,
  expandSkillTarget,
  normalizeSkillTarget,
  SKILL_NAME,
  type SkillModuleRow,
  type SkillsConfig,
  syncSkillTargets,
} from "./skills";

declare const __CLD_VERSION__: string;
declare const __CLD_COMMIT__: string;

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

type TokenProviderConfig = {
  token?: string;
  tokenFile?: string;
  tokenCommand?: string;
  fd0?: {
    name: string;
    scope?: string;
  };
};

type OAuthSessionConfig = {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken?: string;
  refreshTokenFd0?: {
    name: string;
    scope?: string;
  };
  scope?: string;
};

/**
 * OAuth client credentials of a standalone service account (an agent). The
 * secret lives in the config file or in fd0, like a refresh token; the cached
 * access token sits in `oauth` without a refresh token.
 */
type ClientCredentialsConfig = {
  clientId: string;
  clientSecret?: string;
  clientSecretFd0?: {
    name: string;
    scope?: string;
  };
  scope?: string;
};

type CloudCliProfile = TokenProviderConfig & {
  server?: string;
  defaults?: Record<string, string>;
  oauth?: OAuthSessionConfig;
  clientCredentials?: ClientCredentialsConfig;
  /** Plugins served by this profile's Cloud, locked to one stored version each. */
  plugins?: PluginLock;
};

type CloudCliConfig = {
  currentProfile?: string;
  profiles?: Record<string, CloudCliProfile>;
  /** Where the cloud-cli agent skill is written; absent until `cld` has asked. */
  skills?: SkillsConfig;
};

type ParsedArgs = {
  args: string[];
  flags: CloudCliFlags;
};

type GlobalArgs = {
  profile?: string;
  server?: string;
  token?: string;
  tokenFile?: string;
  tokenCommand?: string;
  fd0?: string;
  fd0Scope?: string;
  output: "text" | "json" | "jsonl";
  locale: string;
  /** `--help` or `-h` before the command: print its help instead of running it. */
  help: boolean;
  rest: string[];
};

const DEFAULT_PROFILE = "default";
const OAUTH_CLIENT_ID = "cloud-cli";
const DEFAULT_OAUTH_SCOPE = "openid profile email offline_access read write";
const CONFIG_PATH = configPath();
const TOKEN_TIMEOUT_MS = 10_000;
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;
const OAUTH_REFRESH_SKEW_MS = 60_000;
const PROFILE_LOCK_TIMEOUT_MS = 15_000;
const PROFILE_LOCK_STALE_MS = 60_000;
const BOOLEAN_FLAGS = new Set(["json", "jsonl"]);

const cliVersion = typeof __CLD_VERSION__ === "string" ? __CLD_VERSION__ : "0.0.0-dev";
const cliCommit = typeof __CLD_COMMIT__ === "string" ? __CLD_COMMIT__ : "unknown";

/** Top-level names that plugins can never take over. */
const reservedNames: ReadonlySet<string> = new Set([
  "help",
  "version",
  "login",
  "logout",
  "auth",
  "profile",
  "update",
  "plugins",
  "skills",
]);

const text = (locale: string, en: string, de: string): string => localizeCloudCliText(locale, { en, de });

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
    readonly germanMessage?: string,
  ) {
    super(message);
  }

  localizedMessage(locale: string): string {
    return this.germanMessage ? text(locale, this.message, this.germanMessage) : this.message;
  }
}

// All output goes through the process streams, never `console.log`/`console.error`.
// Once any module touches `process.stdout` (picocolors does at import), Bun's
// console writes to a pipe drop everything past the pipe buffer. Stream writes
// queue until the reader drains them, and the process stays alive until they
// are flushed.
const printLine = (value = "") => {
  process.stdout.write(`${value}\n`);
};
const printErrorLine = (value = "") => {
  process.stderr.write(`${value}\n`);
};

/** A lone `-` is a value (stdin), not a flag: `--from -`. */
const isFlag = (value: string | undefined): boolean => value !== "-" && Boolean(value?.startsWith("-"));

const setFlag = (flags: CloudCliFlags, name: string, value: CloudCliFlagValue) => {
  const existing = flags[name];
  if (existing === undefined) {
    flags[name] = value;
    return;
  }
  if (Array.isArray(existing)) {
    flags[name] = [...existing, String(value)];
    return;
  }
  flags[name] = [String(existing), String(value)];
};

const parseArgs = (argv: string[], booleanFlags = BOOLEAN_FLAGS): ParsedArgs => {
  const args: string[] = [];
  const flags: CloudCliFlags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i]!;
    if (current === "--") {
      args.push(...argv.slice(i + 1));
      break;
    }

    if (!current.startsWith("-") || current === "-") {
      args.push(current);
      continue;
    }

    const flag = current.replace(/^-+/, "");
    const equalsIndex = flag.indexOf("=");
    if (equalsIndex !== -1) {
      setFlag(flags, flag.slice(0, equalsIndex), flag.slice(equalsIndex + 1));
      continue;
    }

    if (booleanFlags.has(flag)) {
      setFlag(flags, flag, true);
      continue;
    }

    const next = argv[i + 1];
    if (next !== undefined && !isFlag(next)) {
      setFlag(flags, flag, next);
      i += 1;
      continue;
    }

    setFlag(flags, flag, true);
  }

  return { args, flags };
};

const takeStringFlag = (flags: CloudCliFlags, ...names: string[]): string | undefined => {
  for (const name of names) {
    const value = flags[name];
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.at(-1);
  }
  return undefined;
};

const takeBooleanFlag = (flags: CloudCliFlags, ...names: string[]): boolean => names.some((name) => flags[name] === true);

const parseGlobalArgs = (argv: string[]): GlobalArgs => {
  const global: string[] = [];
  const rest: string[] = [];
  let commandStarted = false;

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i]!;
    if (commandStarted) {
      rest.push(current);
      continue;
    }

    if (!current.startsWith("-") || current === "-") {
      commandStarted = true;
      rest.push(current);
      continue;
    }

    global.push(current);
    const flagName = current.replace(/^-+/, "").split("=")[0]!;
    const consumesValue = ["profile", "server", "token", "token-file", "token-command", "fd0", "fd0-scope", "config", "locale"].includes(
      flagName,
    );
    if (consumesValue && !current.includes("=") && argv[i + 1] !== undefined) {
      global.push(argv[i + 1]!);
      i += 1;
    }
  }

  const parsed = parseArgs(global);
  const requestedLocale = takeStringFlag(parsed.flags, "locale") ?? envLocale();
  let locale: string;
  try {
    locale = resolveCloudCliLocale(requestedLocale);
  } catch {
    throw new CliError(
      `Invalid locale "${requestedLocale}". Pass a BCP 47 language tag such as en or de-CH.`,
      1,
      `Ungültige Locale "${requestedLocale}". Übergib einen BCP-47-Sprachtag wie en oder de-CH.`,
    );
  }
  return {
    profile: takeStringFlag(parsed.flags, "profile", "p"),
    server: takeStringFlag(parsed.flags, "server"),
    token: takeStringFlag(parsed.flags, "token"),
    tokenFile: takeStringFlag(parsed.flags, "token-file"),
    tokenCommand: takeStringFlag(parsed.flags, "token-command"),
    fd0: takeStringFlag(parsed.flags, "fd0"),
    fd0Scope: takeStringFlag(parsed.flags, "fd0-scope"),
    output: takeBooleanFlag(parsed.flags, "jsonl") ? "jsonl" : takeBooleanFlag(parsed.flags, "json") ? "json" : "text",
    locale,
    help: takeBooleanFlag(parsed.flags, "help", "h"),
    rest,
  };
};

const maskToken = (token: string | undefined): string | undefined => {
  if (!token) return undefined;
  if (token.length <= 16) return "********";
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
};

const hasPersistentTokenProvider = (profile: CloudCliProfile): boolean =>
  Boolean(profile.token || profile.tokenFile || profile.tokenCommand || profile.fd0 || profile.oauth || profile.clientCredentials);

const isModuleHelpRequest = (args: readonly string[], flags: CloudCliFlags): boolean => {
  if (flags.help === true || flags.h === true) return true;
  const last = args.at(-1);
  return last === "help" || last === "--help" || last === "-h";
};

const loadConfig = async (): Promise<CloudCliConfig> => {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as CloudCliConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
};

const saveConfig = async (config: CloudCliConfig): Promise<void> => {
  await mkdir(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  const tempPath = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, CONFIG_PATH);
  await chmod(dirname(CONFIG_PATH), 0o700);
  await chmod(CONFIG_PATH, 0o600);
};

const normalizeServer = (server: string): string => server.replace(/\/+$/, "");

const canonicalServer = (server: string): string => {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new CliError("Cloud server must be an HTTP(S) origin.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new CliError("Cloud server must be an HTTP(S) origin without credentials, path, query, or fragment.");
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
    throw new CliError("Cloud server must use HTTPS unless it is an exact localhost, 127.0.0.1, or ::1 loopback origin.");
  }
  return url.origin;
};

const joinUrl = (server: string, path: string): string => `${normalizeServer(server)}${path.startsWith("/") ? path : `/${path}`}`;

const readTokenFile = async (path: string): Promise<string> => (await readFile(path, "utf8")).trim();

const readFd0Token = async (name: string, scope: string | undefined): Promise<string> => {
  const args = ["get", name, "--raw"];
  if (scope) args.push("--scope", scope);
  try {
    const { stdout } = await execFileAsync("fd0", args, { timeout: TOKEN_TIMEOUT_MS });
    const token = stdout.trim();
    if (!token) throw new CliError(`fd0 returned an empty token for "${name}".`);
    return token;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Failed to read token from fd0: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const writeFd0Secret = async (name: string, scope: string | undefined, value: string): Promise<void> => {
  const args = ["set", name, "-"];
  if (scope) args.push("--scope", scope);

  await new Promise<void>((resolve, reject) => {
    const child = spawn("fd0", args, { stdio: ["pipe", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new CliError(`fd0 timed out while storing "${name}".`));
    }, TOKEN_TIMEOUT_MS);

    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new CliError(`Failed to store token in fd0: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      const message = Buffer.concat(stderr).toString("utf8").trim();
      reject(new CliError(`Failed to store token in fd0${message ? `: ${message}` : ""}`));
    });
    // fd0 may exit before draining stdin (EPIPE). The "close" handler already
    // reports the exit code with fd0's stderr, so the write error only needs
    // to be swallowed instead of crashing the process.
    child.stdin.on("error", () => {});
    child.stdin.end(value);
  });
};

const removeFd0Secret = async (name: string, scope: string | undefined): Promise<void> => {
  const args = ["rm", name, "--yes"];
  if (scope) args.push("--scope", scope);
  try {
    await execFileAsync("fd0", args, { timeout: TOKEN_TIMEOUT_MS });
  } catch (error) {
    printErrorLine(`Warning: failed to remove OAuth refresh token from fd0: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const readCommandToken = async (command: string): Promise<string> => {
  try {
    const { stdout } = await execAsync(command, { timeout: TOKEN_TIMEOUT_MS });
    const token = stdout.trim();
    if (!token) throw new CliError("Token command returned an empty token.");
    return token;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Failed to read token from command: ${error instanceof Error ? error.message : String(error)}`);
  }
};

type OAuthTokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  id_token?: unknown;
};

const parseOAuthTokenResponse = (payload: unknown): OAuthTokenResponse => {
  if (!payload || typeof payload !== "object") throw new CliError("OAuth server returned an invalid token response.");
  const token = payload as Record<string, unknown>;
  if (typeof token.access_token !== "string" || token.access_token.length === 0) {
    throw new CliError("OAuth server returned an invalid access token.");
  }
  if (token.token_type !== "Bearer") throw new CliError("OAuth server returned an unsupported token type.");
  if (typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
    throw new CliError("OAuth server returned an invalid token lifetime.");
  }
  if (token.refresh_token !== undefined && (typeof token.refresh_token !== "string" || token.refresh_token.length === 0)) {
    throw new CliError("OAuth server returned an invalid refresh token.");
  }
  if (token.scope !== undefined && typeof token.scope !== "string") {
    throw new CliError("OAuth server returned an invalid scope.");
  }
  return token as OAuthTokenResponse;
};

const readOAuthTokenResponse = async (response: Response): Promise<OAuthTokenResponse> =>
  parseOAuthTokenResponse(await readJson<unknown>(response));

const fetchOAuth = (url: string, init: RequestInit): Promise<Response> =>
  fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
  });

type ResolvedAuth = {
  token: string;
  refresh?: () => Promise<string>;
};

type ResolvedCliOptions = CloudCliOptions & {
  refresh?: () => Promise<string>;
};

const isOAuthAccessTokenFresh = (session: OAuthSessionConfig): boolean => {
  const expiresAt = Date.parse(session.accessTokenExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now() + OAUTH_REFRESH_SKEW_MS;
};

const readOAuthRefreshToken = async (session: OAuthSessionConfig): Promise<string> => {
  if (session.refreshToken) return session.refreshToken;
  if (session.refreshTokenFd0) return readFd0Token(session.refreshTokenFd0.name, session.refreshTokenFd0.scope);
  throw new CliError("OAuth profile has no refresh token. Run `cld login` again.");
};

const writeOAuthRefreshToken = async (session: OAuthSessionConfig, refreshToken: string): Promise<OAuthSessionConfig> => {
  if (session.refreshTokenFd0) {
    await writeFd0Secret(session.refreshTokenFd0.name, session.refreshTokenFd0.scope, refreshToken);
    return { ...session, refreshToken: undefined };
  }
  return { ...session, refreshToken };
};

const configLockPath = (): string => join(dirname(CONFIG_PATH), "locks", "config.lock");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const cleanupStaleProfileLock = async (lockPath: string): Promise<boolean> => {
  try {
    const metadata = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as { pid?: unknown; createdAt?: unknown };
    const pid = typeof metadata.pid === "number" ? metadata.pid : null;
    const createdAt = typeof metadata.createdAt === "number" ? metadata.createdAt : 0;
    if (pid !== null && isProcessAlive(pid)) return false;
    if (pid === null && Date.now() - createdAt <= PROFILE_LOCK_STALE_MS) return false;
  } catch {
    try {
      const lockStat = await stat(lockPath);
      if (Date.now() - lockStat.mtimeMs <= PROFILE_LOCK_STALE_MS) return false;
    } catch {
      return false;
    }
  }

  await rm(lockPath, { recursive: true, force: true });
  return true;
};

const withConfigLock = async <T>(run: () => Promise<T>): Promise<T> => {
  const lockPath = configLockPath();
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await cleanupStaleProfileLock(lockPath)) continue;
      if (Date.now() - startedAt > PROFILE_LOCK_TIMEOUT_MS) {
        throw new CliError("Timed out waiting for the Cloud CLI config lock.");
      }
      await sleep(100);
    }
  }

  try {
    return await run();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
};

const revokeOAuthRefreshToken = async (server: string, refreshToken: string): Promise<void> => {
  const response = await fetchOAuth(joinUrl(server, "/oauth/revoke"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: refreshToken,
      token_type_hint: "refresh_token",
      client_id: OAUTH_CLIENT_ID,
    }),
  });
  if (!response.ok) throw new CliError(`Remote OAuth revocation failed (${response.status}).`);
};

const removeLocalOAuthSession = async (profileName: string): Promise<void> => {
  const config = await loadConfig();
  const profile = config.profiles?.[profileName];
  if (!profile?.oauth) return;
  delete profile.oauth;
  await saveConfig(config);
};

const refreshOAuthSession = async (profileName: string, server: string, force = false): Promise<string> =>
  withConfigLock(async () => {
    const config = await loadConfig();
    const profile = config.profiles?.[profileName];
    const session = profile?.oauth;
    if (!profile || !session) throw new CliError(`Profile "${profileName}" is not logged in with OAuth.`);
    if (!force && isOAuthAccessTokenFresh(session)) return session.accessToken;

    const refreshToken = await readOAuthRefreshToken(session);
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    });

    const response = await fetchOAuth(joinUrl(server, "/oauth/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const token = await readOAuthTokenResponse(response);
    if (!token.refresh_token) throw new CliError("OAuth server did not rotate the refresh token.");

    let refreshTokenStoredInFd0 = false;
    try {
      const updatedSession = await writeOAuthRefreshToken(
        {
          ...session,
          accessToken: token.access_token,
          accessTokenExpiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
          scope: token.scope ?? session.scope,
        },
        token.refresh_token,
      );
      refreshTokenStoredInFd0 = Boolean(session.refreshTokenFd0);

      config.profiles ??= {};
      config.profiles[profileName] = {
        ...profile,
        oauth: updatedSession,
      };
      await saveConfig(config);
    } catch (error) {
      if (refreshTokenStoredInFd0) {
        printErrorLine(`Warning: refreshed OAuth token, but failed to persist profile metadata: ${(error as Error).message}`);
        return token.access_token;
      }

      await revokeOAuthRefreshToken(server, token.refresh_token).catch((revokeError) => {
        printErrorLine(`Warning: failed to revoke unpersisted refresh token: ${(revokeError as Error).message}`);
      });
      await removeLocalOAuthSession(profileName).catch((removeError) => {
        printErrorLine(`Warning: failed to remove invalid local OAuth session: ${(removeError as Error).message}`);
      });
      throw error;
    }

    return token.access_token;
  });

const readClientSecret = async (credentials: ClientCredentialsConfig): Promise<string> => {
  if (credentials.clientSecret) return credentials.clientSecret;
  if (credentials.clientSecretFd0) return readFd0Token(credentials.clientSecretFd0.name, credentials.clientSecretFd0.scope);
  throw new CliError(
    "Profile has client credentials without a secret. Run `cld admin agents rotate-secret` from an administrator profile.",
  );
};

/** Obtain (or reuse) an access token through the client-credentials grant; the secret never leaves this process except to the token endpoint. */
const obtainClientCredentialsToken = async (profileName: string, server: string, force = false): Promise<string> =>
  withConfigLock(async () => {
    const config = await loadConfig();
    const profile = config.profiles?.[profileName];
    const credentials = profile?.clientCredentials;
    if (!profile || !credentials) throw new CliError(`Profile "${profileName}" has no client credentials.`);
    if (!force && profile.oauth && isOAuthAccessTokenFresh(profile.oauth)) return profile.oauth.accessToken;

    const secret = await readClientSecret(credentials);
    const body = new URLSearchParams({ grant_type: "client_credentials" });
    if (credentials.scope) body.set("scope", credentials.scope);
    const response = await fetchOAuth(joinUrl(server, "/oauth/token"), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${credentials.clientId}:${secret}`, "utf8").toString("base64")}`,
      },
      body,
    });
    if (response.status === 400 || response.status === 401) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (payload?.error === "invalid_client") {
        throw new CliError(
          `Cloud rejected the client credentials of profile "${profileName}". The agent may be disabled or its secret rotated; an administrator can run \`cld admin agents rotate-secret\`.`,
        );
      }
    }
    const token = await readOAuthTokenResponse(response);

    config.profiles ??= {};
    config.profiles[profileName] = {
      ...profile,
      oauth: {
        accessToken: token.access_token,
        accessTokenExpiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
        scope: token.scope ?? credentials.scope,
      },
    };
    await saveConfig(config);
    return token.access_token;
  });

const removeClientCredentials = async (credentials: ClientCredentialsConfig): Promise<void> => {
  if (credentials.clientSecretFd0) await removeFd0Secret(credentials.clientSecretFd0.name, credentials.clientSecretFd0.scope);
};

/** Store client credentials that `cld admin agents` provisioned; replaces every other credential of the profile. */
const saveClientCredentialsProfile = async (input: CloudCliClientCredentialsProfile): Promise<void> => {
  const server = canonicalServer(input.server);
  await withConfigLock(async () => {
    const config = await loadConfig();
    config.profiles ??= {};
    const existing = config.profiles[input.name] ?? {};
    if (existing.oauth?.refreshToken || existing.oauth?.refreshTokenFd0) {
      throw new CliError(
        `Profile "${input.name}" holds a personal OAuth login. Run \`cld logout --profile ${input.name}\` first or choose another profile name.`,
      );
    }
    const displaced = existing.clientCredentials;
    let clientCredentials: ClientCredentialsConfig = { clientId: input.clientId, scope: input.scope };
    if (input.fd0) {
      await writeFd0Secret(input.fd0.name, input.fd0.scope, input.clientSecret);
      clientCredentials = {
        ...clientCredentials,
        clientSecretFd0: { name: input.fd0.name, ...(input.fd0.scope ? { scope: input.fd0.scope } : {}) },
      };
    } else {
      clientCredentials = { ...clientCredentials, clientSecret: input.clientSecret };
    }
    const next: CloudCliProfile = { ...existing, server, clientCredentials };
    delete next.token;
    delete next.tokenFile;
    delete next.tokenCommand;
    delete next.fd0;
    delete next.oauth;
    config.profiles[input.name] = next;
    config.currentProfile ??= input.name;
    await saveConfig(config);
    const reusesFd0 =
      displaced?.clientSecretFd0 &&
      displaced.clientSecretFd0.name === clientCredentials.clientSecretFd0?.name &&
      displaced.clientSecretFd0.scope === clientCredentials.clientSecretFd0?.scope;
    if (displaced && !reusesFd0) await removeClientCredentials(displaced);
  });
};

const resolveAuth = async (
  global: GlobalArgs,
  config: CloudCliConfig,
  profileName: string,
  profile: CloudCliProfile,
  server: string,
  useEnvironment = true,
): Promise<ResolvedAuth> => {
  if (global.token) return { token: global.token };
  const tokenFromEnv = useEnvironment ? envToken() : undefined;
  if (tokenFromEnv) return { token: tokenFromEnv };
  if (global.tokenFile) return { token: await readTokenFile(global.tokenFile) };
  if (global.fd0) return { token: await readFd0Token(global.fd0, global.fd0Scope) };
  if (global.tokenCommand) return { token: await readCommandToken(global.tokenCommand) };
  if (profile.clientCredentials) {
    if (!profile.server || canonicalServer(profile.server) !== canonicalServer(server)) {
      throw new CliError(
        `Profile "${profileName}" holds client credentials for ${profile.server ?? "an unknown server"}, not for ${server}.`,
      );
    }
    const token =
      profile.oauth && isOAuthAccessTokenFresh(profile.oauth)
        ? profile.oauth.accessToken
        : await obtainClientCredentialsToken(profileName, server);
    return { token, refresh: () => obtainClientCredentialsToken(profileName, server, true) };
  }
  if (profile.oauth) {
    if (!profile.server || canonicalServer(profile.server) !== canonicalServer(server)) {
      throw new CliError(
        `OAuth profile "${profileName}" is bound to ${profile.server ?? "an unknown server"}. Run \`cld login\` for ${server}.`,
      );
    }
    const token = isOAuthAccessTokenFresh(profile.oauth) ? profile.oauth.accessToken : await refreshOAuthSession(profileName, server);
    return { token, refresh: () => refreshOAuthSession(profileName, server, true) };
  }
  if (profile.token) return { token: profile.token };
  if (profile.tokenFile) return { token: await readTokenFile(profile.tokenFile) };
  if (profile.fd0) return { token: await readFd0Token(profile.fd0.name, profile.fd0.scope) };
  if (profile.tokenCommand) return { token: await readCommandToken(profile.tokenCommand) };
  if (config.profiles && Object.keys(config.profiles).length === 0) {
    throw new CliError(
      "No login configured. Run `cld login --server <url>`.",
      1,
      "Keine Anmeldung konfiguriert. Führe `cld login --server <URL>` aus.",
    );
  }
  throw new CliError(
    "No token configured. Pass --token, set CLD_TOKEN, or configure a profile.",
    1,
    "Kein Token konfiguriert. Übergib --token, setze CLD_TOKEN oder konfiguriere ein Profil.",
  );
};

const resolveProfileName = (config: CloudCliConfig, requestedProfile: string | undefined): string => {
  if (requestedProfile) return requestedProfile;
  if (config.currentProfile) return config.currentProfile;
  if (config.profiles?.[DEFAULT_PROFILE]) return DEFAULT_PROFILE;
  const profileNames = Object.keys(config.profiles ?? {});
  if (profileNames.length === 1) return profileNames[0]!;
  return DEFAULT_PROFILE;
};

/**
 * Resolve server and credentials. `profileOnly` uses nothing but the saved
 * profile: no flags and no environment, so a command that walks every profile
 * never sends one Cloud's token to another.
 */
const resolveOptions = async (global: GlobalArgs, { profileOnly = false } = {}): Promise<ResolvedCliOptions> => {
  if (profileOnly) {
    global = { ...global, server: undefined, token: undefined, tokenFile: undefined, tokenCommand: undefined, fd0: undefined };
  }
  const config = await loadConfig();
  const profileName = resolveProfileName(config, global.profile);
  const profile = config.profiles?.[profileName] ?? {};
  const server = profileOnly ? profile.server : (global.server ?? envServer() ?? profile.server);
  if (!server)
    throw new CliError(
      "No server configured. Pass --server or run `cld profile set --server <url>`.",
      1,
      "Kein Server konfiguriert. Übergib --server oder führe `cld profile set --server <URL>` aus.",
    );
  const normalizedServer = canonicalServer(server);
  const auth = await resolveAuth(global, config, profileName, profile, normalizedServer, !profileOnly);
  return {
    profile: profileName,
    server: normalizedServer,
    token: auth.token,
    refresh: auth.refresh,
    output: global.output,
    locale: global.locale,
  };
};

const resolveOfflineOptions = async (global: GlobalArgs): Promise<ResolvedCliOptions> => {
  const config = await loadConfig();
  const profileName = resolveProfileName(config, global.profile);
  const profile = config.profiles?.[profileName] ?? {};
  const server = global.server ?? envServer() ?? profile.server ?? "";
  return {
    profile: profileName,
    server: server ? normalizeServer(server) : "",
    token: global.token ?? envToken() ?? profile.token ?? "",
    output: global.output,
    locale: global.locale,
  };
};

const readJson = async <T>(response: Pick<Response, "json" | "text" | "ok" | "status" | "statusText">): Promise<T> => {
  const text = await response.text().catch(() => "");
  const payload = text.length > 0 ? tryParseJson(text) : null;
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message?: unknown }).message)
        : payload && typeof payload === "object" && "error" in payload
          ? String((payload as { error?: unknown }).error)
          : text.trim() || response.statusText;
    throw new CliError(`${response.status} ${message}`);
  }
  return payload as T;
};

const tryParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

const renderTable = <TRow extends Record<string, unknown>>(rows: TRow[], columns: CloudCliTableColumn<TRow>[]): string => {
  if (rows.length === 0) return "";
  const values = rows.map((row) =>
    columns.map((column) => {
      const value = column.value ? column.value(row) : row[column.key as keyof TRow];
      return value === null || value === undefined ? "" : String(value);
    }),
  );
  const headers = columns.map((column) => column.label ?? String(column.key));
  const widths = headers.map((header, index) => Math.max(header.length, ...values.map((row) => row[index]?.length ?? 0)));
  const renderRow = (row: string[]) =>
    row
      .map((value, index) => value.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  return [renderRow(headers), renderRow(widths.map((width) => "-".repeat(width))), ...values.map(renderRow)].join("\n");
};

const createContext = (args: string[], flags: CloudCliFlags, options: ResolvedCliOptions): CloudCliContext => {
  let bearerToken = options.token;
  const cloudOrigin = options.server ? new URL(options.server).origin : null;
  const authHeaders = () => ({ Authorization: `Bearer ${bearerToken}` });
  const fetchWithAuth = async (pathOrUrl: string | URL | Request, init: RequestInit = {}, retry = true): Promise<Response> => {
    const url =
      typeof pathOrUrl === "string" && pathOrUrl.startsWith("/")
        ? joinUrl(options.server, pathOrUrl)
        : (pathOrUrl as string | URL | Request);
    const requestUrl = new URL(pathOrUrl instanceof Request ? pathOrUrl.url : String(url), options.server);
    if (!cloudOrigin || requestUrl.origin !== cloudOrigin) {
      throw new CliError(`Refusing to send Cloud credentials to ${requestUrl.origin}.`);
    }
    const headers = new Headers(pathOrUrl instanceof Request ? pathOrUrl.headers : undefined);
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    headers.set("authorization", `Bearer ${bearerToken}`);
    headers.set("accept-language", options.locale ?? "en");
    const response = await fetch(url, {
      ...init,
      headers,
    });
    if (response.status === 401 && retry && options.refresh) {
      bearerToken = await options.refresh();
      return fetchWithAuth(pathOrUrl, init, false);
    }
    return response;
  };

  return {
    args,
    flags,
    options,
    getDefault: async (key) => {
      const config = await loadConfig();
      return config.profiles?.[options.profile]?.defaults?.[key];
    },
    setDefault: async (key, value) => {
      let hadPersistentToken = false;
      await withConfigLock(async () => {
        const config = await loadConfig();
        config.profiles ??= {};
        const profile = config.profiles[options.profile] ?? {};
        hadPersistentToken = hasPersistentTokenProvider(profile);
        const defaults = { ...(profile.defaults ?? {}) };
        if (value === undefined) delete defaults[key];
        else defaults[key] = value;
        config.profiles[options.profile] = {
          ...profile,
          server: profile.server ?? options.server,
          defaults: Object.keys(defaults).length > 0 ? defaults : undefined,
        };
        await saveConfig(config);
      });
      if (value !== undefined && !hadPersistentToken) {
        printErrorLine(
          `Warning: saved a default for profile "${options.profile}", but this profile has no persistent token provider. Run \`cld profile set ${options.profile} --server ${options.server} --token-file <path>\` or pass a token/env token on future calls.`,
        );
      }
    },
    createApiClient: <TApi extends Hono<any, any, any>>(basePath: string) =>
      hc<TApi>(joinUrl(options.server, basePath), {
        headers: authHeaders,
        fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetchWithAuth(input, init),
      }),
    fetch: (path, init = {}) => fetchWithAuth(path, init),
    readJson,
    print: (value = "") => {
      printLine(value);
    },
    write: (value) =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(value, (error) => (error ? reject(error) : resolve()));
      }),
    error: (value) => {
      printErrorLine(value);
    },
    json: (value) => {
      printLine(JSON.stringify(value, null, 2));
    },
    jsonLine: (value) => {
      printLine(JSON.stringify(value));
    },
    table: (rows, columns) => {
      const rendered = renderTable(rows, columns);
      if (rendered) printLine(rendered);
    },
    profiles: { saveClientCredentials: saveClientCredentialsProfile },
  };
};

type ModuleSummary = Pick<CloudCliModule, "name" | "summary">;

const moduleList = (locale: string, modules: ModuleSummary[]): string =>
  modules.length === 0
    ? text(
        locale,
        "  (none installed; `cld login` offers your Cloud's modules, `cld plugins install --all` installs them)",
        "  (keine installiert; `cld login` bietet die Module deiner Cloud an, `cld plugins install --all` installiert sie)",
      )
    : modules.map((module) => `  ${module.name.padEnd(12)} ${module.summary}`).join("\n");

const helpText = (locale: string, pluginModules: ModuleSummary[]): string =>
  text(
    locale,
    `cld

Usage:
  cld [global options] <module> <command> [options]
  cld <module> reference [file]
  cld login [profile] --server <url> [--device]
  cld logout [--profile <name>]
  cld auth status
  cld profile <list|show|use|set> [options]
  cld update [--version <version>] [--yes] [--no-verify]
  cld plugins <list|install|update|remove|run> [options]
  cld skills <list|add|remove|sync> [options]
  cld --version

Global options:
  --profile <name>        Profile name (default: current profile)
  --server <url>          Cloud server URL
  --token <token>         Bearer token
  --token-file <path>     Read bearer token from file
  --fd0 <name>            Read bearer token via fd0 get <name> --raw
  --fd0-scope <scope>     fd0 scope
  --token-command <cmd>   Read bearer token from command stdout
  --locale <tag>          Human text locale (default: CLD_LOCALE or en)
  --json                  Print JSON where supported
  --jsonl                 Stream one JSON event per line where supported
  -h, --help              Print the command's help instead of running it

Modules (installed for the current profile; every Cloud app serves its own):
${moduleList(locale, pluginModules)}

Examples:
  cld login --server http://localhost:3000
  cld login --server https://cloud.example --device
  cld --server http://localhost:3000 --token cld_... notebooks ls
  cld profile set --server http://localhost:3000 --fd0 cloud-local-token --fd0-scope my-scope
  cld notebooks cat <notebook>:<path>
`,
    `cld

Verwendung:
  cld [globale Optionen] <Modul> <Befehl> [Optionen]
  cld <Modul> reference [Datei]
  cld login [Profil] --server <URL> [--device]
  cld logout [--profile <Name>]
  cld auth status
  cld profile <list|show|use|set> [Optionen]
  cld update [--version <Version>] [--yes] [--no-verify]
  cld plugins <list|install|update|remove|run> [Optionen]
  cld skills <list|add|remove|sync> [Optionen]
  cld --version

Globale Optionen:
  --profile <Name>        Profilname (Standard: aktuelles Profil)
  --server <URL>          URL des Cloud-Servers
  --token <Token>         Bearer-Token
  --token-file <Pfad>     Bearer-Token aus einer Datei lesen
  --fd0 <Name>            Bearer-Token über fd0 get <Name> --raw lesen
  --fd0-scope <Scope>     fd0-Scope
  --token-command <Befehl> Bearer-Token aus stdout eines Befehls lesen
  --locale <Tag>          Sprache für menschenlesbaren Text (Standard: CLD_LOCALE oder en)
  --json                  JSON ausgeben, sofern unterstützt
  --jsonl                 Ein kompaktes JSON-Ereignis pro Zeile ausgeben
  -h, --help              Hilfe des Befehls ausgeben, statt ihn auszuführen

Module (für das aktuelle Profil installiert; jede Cloud-App stellt ihr eigenes bereit):
${moduleList(locale, pluginModules)}

Beispiele:
  cld login --server http://localhost:3000
  cld login --server https://cloud.example --device
  cld --server http://localhost:3000 --token cld_... notebooks ls
  cld profile set --server http://localhost:3000 --fd0 cloud-local-token --fd0-scope my-scope
  cld notebooks cat <notebook>:<path>
`,
  );

const profileHelp = (locale: string): string =>
  text(
    locale,
    `cld profile

Usage:
  cld profile list
  cld profile show [name]
  cld profile use <name>
  cld profile set [name] --server <url> [--token <token>]
  cld profile set [name] --server <url> --token-file <path>
  cld profile set [name] --server <url> --fd0 <secret> [--fd0-scope <scope>]
  cld profile set [name] --server <url> --token-command <command>

An agent profile with OAuth client credentials is written by
\`cld admin agents create <name> --profile <profile>\`; cld obtains and renews
its access tokens itself. \`cld logout --profile <profile>\` removes them locally.
`,
    `cld profile

Verwendung:
  cld profile list
  cld profile show [Name]
  cld profile use <Name>
  cld profile set [Name] --server <URL> [--token <Token>]
  cld profile set [Name] --server <URL> --token-file <Pfad>
  cld profile set [Name] --server <URL> --fd0 <Secret> [--fd0-scope <Scope>]
  cld profile set [Name] --server <URL> --token-command <Befehl>

Ein Agent-Profil mit OAuth-Client-Zugangsdaten schreibt
\`cld admin agents create <Name> --profile <Profil>\`; cld holt und erneuert
seine Access-Tokens selbst. \`cld logout --profile <Profil>\` entfernt sie lokal.
`,
  );

const logoutHelp = (locale: string): string =>
  text(
    locale,
    `cld logout

Usage:
  cld logout [--profile <name>]

Signs a profile out (default: the current profile). An OAuth login is revoked
at the Cloud and removed locally, together with a refresh token kept in fd0.
An agent profile's client credentials are removed locally only; an
administrator revokes the agent with \`cld admin agents revoke\`. A token,
token file, token command, or fd0 token set with \`cld profile set\` stays.
`,
    `cld logout

Verwendung:
  cld logout [--profile <Name>]

Meldet ein Profil ab (Standard: aktuelles Profil). Eine OAuth-Anmeldung wird bei
der Cloud widerrufen und lokal entfernt, zusammen mit einem Refresh-Token in fd0.
Die Client-Zugangsdaten eines Agent-Profils werden nur lokal entfernt; ein
Administrator widerruft den Agent mit \`cld admin agents revoke\`. Ein Token,
eine Token-Datei, ein Token-Befehl oder ein fd0-Token aus \`cld profile set\`
bleibt erhalten.
`,
  );

const authHelp = (locale: string): string =>
  text(
    locale,
    `cld auth

Usage:
  cld auth [status] [--profile <name>] [--json]

Shows how a profile signs in (default: the current profile): its server, the
kind of credential, when the OAuth access token expires, and where the refresh
token or client secret is stored. It never prints a secret.
`,
    `cld auth

Verwendung:
  cld auth [status] [--profile <Name>] [--json]

Zeigt, wie sich ein Profil anmeldet (Standard: aktuelles Profil): seinen Server,
die Art der Zugangsdaten, wann das OAuth-Access-Token abläuft und wo das
Refresh-Token oder Client-Secret liegt. Ein Secret gibt es nie aus.
`,
  );

const versionHelp = (locale: string): string =>
  text(
    locale,
    `cld version

Usage:
  cld version
  cld --version

Prints the release and commit of this cld.
`,
    `cld version

Verwendung:
  cld version
  cld --version

Gibt Release und Commit dieses cld aus.
`,
  );

const loginHelp = (locale: string): string =>
  text(
    locale,
    `cld login

Usage:
  cld login [profile] --server <url> [options]

Signs in with your Cloud account and stores a refreshable OAuth login in the
profile (default: the current profile, or "default").

Options:
  --server <url>        Cloud origin (default: --server, CLD_SERVER, or the profile's server)
  --device              Sign in with a code instead of a local browser. Use this over SSH
                        or on any machine without a browser: open the printed URL on your
                        laptop or phone, sign in, and enter the code.
  --no-open             Print the login URL instead of offering to open a browser
  --scope <scopes>      OAuth scopes (default: ${DEFAULT_OAUTH_SCOPE})
  --fd0 [name]          Store the refresh token in fd0 (default name: cloud-<profile>-oauth-refresh-token)
  --fd0-scope <scope>   fd0 scope for the refresh token
  --yes                 Install the Cloud's plugins without asking
  --no-plugins          Do not offer the Cloud's plugins after signing in

After signing in, cld offers to install the plugins this Cloud serves.

Examples:
  cld login --server https://cloud.example
  cld login portal --server https://cloud.example --device
`,
    `cld login

Verwendung:
  cld login [Profil] --server <URL> [Optionen]

Meldet dich mit deinem Cloud-Konto an und speichert eine erneuerbare
OAuth-Anmeldung im Profil (Standard: aktuelles Profil oder "default").

Optionen:
  --server <URL>        Cloud-Origin (Standard: --server, CLD_SERVER oder der Server des Profils)
  --device              Mit einem Code statt mit einem lokalen Browser anmelden. Für SSH
                        und Rechner ohne Browser: Öffne die angezeigte URL auf Laptop oder
                        Smartphone, melde dich an und gib den Code ein.
  --no-open             Anmelde-URL ausgeben, statt das Öffnen eines Browsers anzubieten
  --scope <Scopes>      OAuth-Scopes (Standard: ${DEFAULT_OAUTH_SCOPE})
  --fd0 [Name]          Refresh-Token in fd0 speichern (Standardname: cloud-<Profil>-oauth-refresh-token)
  --fd0-scope <Scope>   fd0-Scope für das Refresh-Token
  --yes                 Plugins der Cloud ohne Rückfrage installieren
  --no-plugins          Nach der Anmeldung keine Plugins der Cloud anbieten

Nach der Anmeldung bietet cld an, die Plugins dieser Cloud zu installieren.

Beispiele:
  cld login --server https://cloud.example
  cld login portal --server https://cloud.example --device
`,
  );

const updateHelp = (locale: string): string =>
  text(
    locale,
    `cld update

Usage:
  cld update [--version <version>] [--yes] [--no-verify] [--no-skills] [--skills-dir <dir>] [--claude-symlink]

Options:
  --version <version>  Install cli-vX.Y.Z or X.Y.Z (default: latest CLI release)
  --yes                Skip the confirmation prompt; if no skill target was ever chosen, use ${DEFAULT_SKILL_TARGET}
  --no-verify          Skip optional Cosign verification; SHA-256 is always verified
  --no-skills          Do not rewrite the Cloud CLI agent skill afterwards
  --skills-dir <dir>   Add <dir> to the skill targets (default target: ${DEFAULT_SKILL_TARGET})
  --claude-symlink     Add ${CLAUDE_SKILL_TARGET} to the skill targets for Claude Code

After the update, cld rewrites the cloud-cli skill in every target (\`cld skills list\`).
`,
    `cld update

Verwendung:
  cld update [--version <Version>] [--yes] [--no-verify] [--no-skills] [--skills-dir <Verzeichnis>] [--claude-symlink]

Optionen:
  --version <Version>  cli-vX.Y.Z oder X.Y.Z installieren (Standard: neuestes CLI-Release)
  --yes                Bestätigungsabfrage überspringen; wurde nie ein Skill-Ziel gewählt, ${DEFAULT_SKILL_TARGET} nehmen
  --no-verify          Optionale Cosign-Prüfung überspringen; SHA-256 wird immer geprüft
  --no-skills          Den Cloud-CLI-Agent-Skill danach nicht neu schreiben
  --skills-dir <Pfad>  <Pfad> zu den Skill-Zielen hinzufügen (Standardziel: ${DEFAULT_SKILL_TARGET})
  --claude-symlink     ${CLAUDE_SKILL_TARGET} für Claude Code zu den Skill-Zielen hinzufügen

Nach dem Update schreibt cld den cloud-cli-Skill in jedes Ziel neu (\`cld skills list\`).
`,
  );

const confirmCliUpdate = async (message: string): Promise<boolean> => {
  if (!process.stdin.isTTY) throw new CliError("Not a terminal; pass --yes to update non-interactively.");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`${message} [Y/n] `);
    return answer === "" || /^(y|yes)$/i.test(answer);
  } finally {
    prompt.close();
  }
};

const runUpdateCommand = async (args: string[], locale: string): Promise<number> => {
  const parsed = parseArgs(args);
  if (parsed.args.length > 0)
    throw new CliError(
      "Usage: cld update [--version <version>] [--yes] [--no-verify] [--no-skills] [--skills-dir <dir>] [--claude-symlink]",
    );
  const allowedFlags = new Set(["version", "yes", "y", "no-verify", "no-skills", "skills-dir", "claude-symlink"]);
  const unsupportedFlag = Object.keys(parsed.flags).find((flag) => !allowedFlags.has(flag));
  if (unsupportedFlag) throw new CliError(`Unknown update option "--${unsupportedFlag}".`);
  if (parsed.flags.version === true) throw new CliError("--version requires a value.");
  if (parsed.flags["skills-dir"] === true) throw new CliError("--skills-dir requires a value.");
  const version = takeStringFlag(parsed.flags, "version");
  const yes = takeBooleanFlag(parsed.flags, "yes", "y");
  const noVerify = takeBooleanFlag(parsed.flags, "no-verify");
  const noSkills = takeBooleanFlag(parsed.flags, "no-skills");
  const claudeSymlink = takeBooleanFlag(parsed.flags, "claude-symlink");
  const skillsDir = takeStringFlag(parsed.flags, "skills-dir");
  const result = await updateCli({ version, verifyCosign: !noVerify, confirm: yes ? undefined : confirmCliUpdate });
  const added = [...(skillsDir ? [skillsDir] : []), ...(claudeSymlink ? [CLAUDE_SKILL_TARGET] : [])].map(normalizeSkillTarget);
  if (added.length > 0) await addSkillTargets(added);
  const verification =
    result.cosign === "verified"
      ? "SHA-256 and Cosign verified"
      : result.cosign === "unavailable"
        ? "SHA-256 verified; Cosign unavailable"
        : "SHA-256 verified";
  printLine(result.replaced ? `Updated cld to ${result.release.version} (${verification}).` : `cld ${cliVersion} is already up to date.`);
  if (noSkills) return 0;
  // The skill belongs to the release that runs: the new binary asks for targets and writes it after a replacement.
  if (result.replaced) {
    for (const path of await spawnSkillSync(process.execPath, yes))
      printLine(text(locale, `Wrote the cloud-cli skill to ${path}.`, `cloud-cli-Skill nach ${path} geschrieben.`));
    return 0;
  }
  const config = (await offerSkillTargets(locale, yes)) ?? (await loadConfig());
  if (config.skills === undefined) printErrorLine(noSkillTargetHint(locale));
  const written = await syncSkills(config, locale);
  for (const path of written) printLine(text(locale, `Wrote the cloud-cli skill to ${path}.`, `cloud-cli-Skill nach ${path} geschrieben.`));
  return 0;
};

/**
 * Run `cld skills sync` on `executable` (the freshly installed binary) and
 * return the written paths. It inherits the terminal, so it can ask for the
 * skill targets of a config that has none yet.
 */
const spawnSkillSync = async (executable: string, yes: boolean): Promise<string[]> => {
  const child = Bun.spawn([executable, "--json", "skills", "sync", ...(yes ? ["--yes"] : [])], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit",
  });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (exitCode !== 0) return [];
  const parsed: unknown = JSON.parse(stdout);
  return typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { written?: unknown }).written)
    ? ((parsed as { written: string[] }).written ?? [])
    : [];
};

/** Run one installed module with the shared context. */
const runModule = async (module: CloudCliModule, moduleArgs: string[], global: GlobalArgs): Promise<number> => {
  if (moduleArgs[0] === "help" || moduleArgs[0] === "--help" || moduleArgs[0] === "-h") {
    printLine(module.help?.(global.locale) ?? `${module.name}: ${module.summary}`);
    return 0;
  }

  const parsed = parseArgs(moduleArgs, new Set([...BOOLEAN_FLAGS, ...(module.booleanFlags ?? [])]));
  const helpRequest = isModuleHelpRequest(parsed.args, parsed.flags);
  const requiresCloud = module.requiresCloudFor?.(parsed.args, parsed.flags) ?? module.requiresCloud !== false;
  const resolvedOptions = !requiresCloud || helpRequest ? await resolveOfflineOptions(global) : await resolveOptions(global);
  const options: ResolvedCliOptions = {
    ...resolvedOptions,
    output: takeBooleanFlag(parsed.flags, "jsonl") ? "jsonl" : takeBooleanFlag(parsed.flags, "json") ? "json" : resolvedOptions.output,
  };
  const code = await module.run(createContext(parsed.args, parsed.flags, options));
  return code ?? 0;
};

const pluginsHelp = (locale: string): string =>
  text(
    locale,
    `cld plugins

Usage:
  cld plugins list [--all] [--json]
  cld plugins install <name>... | --all
  cld plugins install <./directory|package.tgz|npm:package[@version]> [--yes]
  cld plugins update [<name>...] [--all]
  cld plugins remove <name>
  cld plugins run <name> [args...]

Every Cloud application serves its own commands as a plugin. \`install <name>\`
downloads a plugin from the current profile's Cloud, checks the SHA-512 of every
file, and locks that version for the profile. \`update\` fetches newer versions for
the current profile, or for every profile with --all. \`list --all\` covers every
profile. Profiles share identical plugin versions on disk.

A local directory, a .tgz archive, or an npm: package installs a plugin for every
profile, for development or for commands that no Cloud serves. Such a plugin runs
inside cld with your Cloud credentials; install only plugins you trust.

Plugin commands run as \`cld <name> ...\`. \`cld plugins run <name>\` always reaches the
plugin, even when a built-in command with the same name takes precedence.

Directory: ${pluginsDirectory()}
`,
    `cld plugins

Verwendung:
  cld plugins list [--all] [--json]
  cld plugins install <Name>... | --all
  cld plugins install <./Verzeichnis|Paket.tgz|npm:Paket[@Version]> [--yes]
  cld plugins update [<Name>...] [--all]
  cld plugins remove <Name>
  cld plugins run <Name> [Argumente...]

Jede Cloud-Anwendung stellt ihre Befehle als Plugin bereit. \`install <Name>\` lädt
ein Plugin von der Cloud des aktuellen Profils, prüft den SHA-512 jeder Datei und
legt diese Version für das Profil fest. \`update\` holt neuere Versionen für das
aktuelle Profil, mit --all für alle Profile. \`list --all\` zeigt alle Profile.
Profile teilen sich identische Plugin-Versionen auf der Festplatte.

Ein lokales Verzeichnis, ein .tgz-Archiv oder ein npm:-Paket installiert ein Plugin
für alle Profile, zum Entwickeln oder für Befehle, die keine Cloud bereitstellt. Ein
solches Plugin läuft in cld mit deinen Cloud-Zugangsdaten; installiere nur Plugins,
denen du vertraust.

Plugin-Befehle laufen als \`cld <Name> ...\`. \`cld plugins run <Name>\` erreicht das Plugin
immer, auch wenn ein eingebauter Befehl mit demselben Namen Vorrang hat.

Verzeichnis: ${pluginsDirectory()}
`,
  );

const warnSkippedPlugin = (plugin: PluginInfo, locale: string): void => {
  if (plugin.status === "shadowed") {
    printErrorLine(
      text(
        locale,
        `cld: plugin "${plugin.id}" shadowed by a built-in command, use \`cld plugins run ${plugin.id}\``,
        `cld: Plugin "${plugin.id}" verdeckt durch eingebauten Befehl, nutze \`cld plugins run ${plugin.id}\``,
      ),
    );
    return;
  }
  printErrorLine(
    text(
      locale,
      `cld: plugin "${plugin.id}" skipped (${plugin.status}): ${plugin.message}`,
      `cld: Plugin "${plugin.id}" übersprungen (${plugin.status}): ${plugin.message}`,
    ),
  );
};

const confirmPluginInstall = async (message: string, locale: string, defaultYes = false): Promise<boolean> => {
  if (!process.stdin.isTTY) {
    throw new CliError(
      "Not a terminal; pass --yes to install the plugin non-interactively.",
      1,
      "Kein Terminal; übergib --yes, um das Plugin ohne Rückfrage zu installieren.",
    );
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const choices = defaultYes ? text(locale, "[Y/n]", "[J/n]") : text(locale, "[y/N]", "[j/N]");
    const answer = (await prompt.question(`${message} ${choices} `)).trim();
    return (defaultYes && answer === "") || /^(y|yes|j|ja)$/i.test(answer);
  } finally {
    prompt.close();
  }
};

const pluginFailure = (error: unknown, action: string, germanAction: string): never => {
  if (error instanceof PluginError) throw new CliError(`${action}: ${error.message}`, 1, `${germanAction}: ${error.message}`);
  throw error;
};

const profileLock = (config: CloudCliConfig, profileName: string): PluginLock => readPluginLock(config.profiles?.[profileName]?.plugins);

/** Digests any profile still locks; everything else in the store may go. */
const lockedDigests = (config: CloudCliConfig): Set<string> =>
  new Set(Object.keys(config.profiles ?? {}).flatMap((name) => Object.values(profileLock(config, name)).map((entry) => entry.digest)));

/**
 * Load an installed plugin: the one the profile locks, else a package plugin
 * installed for every profile. Undefined when neither exists.
 */
const loadInstalledModule = async (name: string, global: GlobalArgs): Promise<CloudCliModule | undefined> => {
  const locked = await lockedPlugin(name, global);
  const module = locked ? loadStoredPlugin(name, locked) : loadPlugin(name);
  return module.catch((error) => pluginFailure(error, `Plugin "${name}" cannot run`, `Plugin "${name}" kann nicht ausgeführt werden`));
};

/** The current profile's lock entry for `name`, if the profile installed it from its Cloud. */
const lockedPlugin = async (name: string, global: GlobalArgs): Promise<LockedPlugin | undefined> => {
  const config = await loadConfig();
  return profileLock(config, resolveProfileName(config, global.profile))[name];
};

/** `cld <module> reference [file]`: print a served plugin's skill reference. */
const runReferenceCommand = async (name: string, locked: LockedPlugin, args: string[]): Promise<number> => {
  const [file, ...extra] = args;
  if (extra.length > 0 || file?.startsWith("-")) {
    throw new CliError(`Usage: cld ${name} reference [file]`, 1, `Verwendung: cld ${name} reference [Datei]`);
  }
  const markdown = await readStoredReference(name, locked, file).catch((error) =>
    pluginFailure(error, `Cannot read the "${name}" reference`, `Referenz von "${name}" kann nicht gelesen werden`),
  );
  process.stdout.write(markdown);
  return 0;
};

/** Every installed module of every profile, for the generated skill table. */
const skillRows = (config: CloudCliConfig): SkillModuleRow[] =>
  Object.keys(config.profiles ?? {})
    .sort()
    .flatMap((profile) =>
      Object.entries(profileLock(config, profile))
        .filter(([name]) => !reservedNames.has(name))
        .map(([name, locked]) => ({ profile, name, version: locked.version, digest: locked.digest })),
    );

/**
 * Rewrite the skill in every configured target from `config`. Problems never
 * fail the command that changed the plugins; they become one stderr line.
 */
const syncSkills = async (config: CloudCliConfig, locale: string): Promise<string[]> => {
  const targets = config.skills?.targets ?? [];
  if (targets.length === 0) return [];
  try {
    return await syncSkillTargets(targets, skillRows(config));
  } catch (error) {
    printErrorLine(
      text(
        locale,
        `cld: skill not updated: ${error instanceof Error ? error.message : String(error)}`,
        `cld: Skill nicht aktualisiert: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return [];
  }
};

const skillsHelp = (locale: string): string =>
  text(
    locale,
    `cld skills

Usage:
  cld skills list [--json]
  cld skills add <directory>
  cld skills remove <directory>
  cld skills sync [--yes]

cld writes the cloud-cli agent skill into every target directory: the core
SKILL.md and references of this cld release, plus references/<module>/<version>/
for every module a profile has installed, and a table in SKILL.md that maps each
profile to its modules. The default target is ${DEFAULT_SKILL_TARGET}; add
${CLAUDE_SKILL_TARGET} for Claude Code. Every change to the installed plugins and
every \`cld update\` rewrites all targets; \`sync\` rewrites them now. When no
target was ever chosen, \`sync\` and \`cld update\` ask once; --yes takes the
default target.
`,
    `cld skills

Verwendung:
  cld skills list [--json]
  cld skills add <Verzeichnis>
  cld skills remove <Verzeichnis>
  cld skills sync [--yes]

cld schreibt den cloud-cli-Agent-Skill in jedes Zielverzeichnis: SKILL.md und
Referenzen dieses cld-Releases sowie references/<Modul>/<Version>/ für jedes
Modul, das ein Profil installiert hat, und eine Tabelle in SKILL.md, die jedem
Profil seine Module zuordnet. Standardziel ist ${DEFAULT_SKILL_TARGET}; für
Claude Code kommt ${CLAUDE_SKILL_TARGET} hinzu. Jede Änderung an den installierten
Plugins und jedes \`cld update\` schreibt alle Ziele neu; \`sync\` tut es sofort.
Wurde nie ein Ziel gewählt, fragen \`sync\` und \`cld update\` einmal; --yes nimmt
das Standardziel.
`,
  );

const runSkillsCommand = async (args: string[], global: GlobalArgs): Promise<number> => {
  const locale = global.locale;
  const parsed = parseArgs(args, new Set([...BOOLEAN_FLAGS, "yes", "y"]));
  const [command, target, ...extra] = parsed.args;
  if (!command) {
    printLine(skillsHelp(locale));
    return 0;
  }
  const output = takeBooleanFlag(parsed.flags, "jsonl") ? "jsonl" : takeBooleanFlag(parsed.flags, "json") ? "json" : global.output;
  const yes = takeBooleanFlag(parsed.flags, "yes", "y");
  if (yes && command !== "sync") throw new CliError("--yes applies only to `cld skills sync`.");
  const unsupportedFlag = Object.keys(parsed.flags).find((flag) => !["json", "jsonl", "yes", "y"].includes(flag));
  if (unsupportedFlag) throw new CliError(`Unknown skills option "--${unsupportedFlag}".`);
  if (extra.length > 0 || (command === "add" || command === "remove") !== Boolean(target)) {
    throw new CliError("Usage: cld skills <list|add <directory>|remove <directory>|sync>. Run `cld skills help`.");
  }
  if (command === "list") {
    const config = await loadConfig();
    const targets = config.skills?.targets ?? [];
    if (output !== "text") printLine(JSON.stringify({ targets, asked: config.skills !== undefined }, null, output === "json" ? 2 : 0));
    else if (targets.length === 0) {
      printLine(
        text(
          locale,
          `No skill target configured. Run \`cld skills add ${DEFAULT_SKILL_TARGET}\` to write the cloud-cli skill for agents.`,
          `Kein Skill-Ziel konfiguriert. Führe \`cld skills add ${DEFAULT_SKILL_TARGET}\` aus, um den cloud-cli-Skill für Agenten zu schreiben.`,
        ),
      );
    } else for (const entry of targets) printLine(join(expandSkillTarget(entry), SKILL_NAME));
    return 0;
  }
  if (command === "add" || command === "remove") {
    const normalized = normalizeSkillTarget(target!);
    const config =
      command === "add"
        ? await addSkillTargets([normalized])
        : await withConfigLock(async () => {
            const latest = await loadConfig();
            latest.skills = { targets: (latest.skills?.targets ?? []).filter((entry) => entry !== normalized) };
            await saveConfig(latest);
            return latest;
          });
    if (command === "remove") {
      await rm(join(expandSkillTarget(normalized), SKILL_NAME), { recursive: true, force: true });
      printLine(text(locale, `Removed the cloud-cli skill from ${normalized}.`, `cloud-cli-Skill aus ${normalized} entfernt.`));
      return 0;
    }
    const written = await syncSkillTargets([normalized], skillRows(config));
    printLine(text(locale, `Wrote the cloud-cli skill to ${written[0]}.`, `cloud-cli-Skill nach ${written[0]} geschrieben.`));
    return 0;
  }
  if (command === "sync") {
    const config = (await offerSkillTargets(locale, yes)) ?? (await loadConfig());
    if ((config.skills?.targets ?? []).length === 0) {
      throw new CliError(
        `No skill target configured. Run \`cld skills add ${DEFAULT_SKILL_TARGET}\` first.`,
        1,
        `Kein Skill-Ziel konfiguriert. Führe zuerst \`cld skills add ${DEFAULT_SKILL_TARGET}\` aus.`,
      );
    }
    const written = await syncSkillTargets(config.skills!.targets, skillRows(config));
    if (output !== "text") printLine(JSON.stringify({ written }, null, output === "json" ? 2 : 0));
    else
      for (const path of written)
        printLine(text(locale, `Wrote the cloud-cli skill to ${path}.`, `cloud-cli-Skill nach ${path} geschrieben.`));
    return 0;
  }
  throw new CliError("Usage: cld skills <list|add <directory>|remove <directory>|sync>. Run `cld skills help`.");
};

/** Add skill targets to the config (deduplicated, in order) and return the saved config. */
const addSkillTargets = (targets: readonly string[]): Promise<CloudCliConfig> =>
  withConfigLock(async () => {
    const latest = await loadConfig();
    const current = latest.skills?.targets ?? [];
    latest.skills = { targets: [...current, ...targets.filter((entry) => !current.includes(entry))] };
    await saveConfig(latest);
    return latest;
  });

/**
 * Ask once where the agent skill should live, when the config has no `skills`
 * yet (first login, or a config from before skill targets). `--yes` takes the
 * default target. Returns the saved config, or null when nothing was asked:
 * the answer is already recorded, or there is no terminal and no `--yes`, and
 * the next interactive login, update, or sync asks.
 */
const offerSkillTargets = async (locale: string, yes: boolean): Promise<CloudCliConfig | null> => {
  if ((await loadConfig()).skills !== undefined) return null;
  let targets: string[] = [];
  if (yes) targets = [DEFAULT_SKILL_TARGET];
  else if (!process.stdin.isTTY) return null;
  else {
    if (
      await confirmPluginInstall(
        text(
          locale,
          `Write the cloud-cli agent skill to ${DEFAULT_SKILL_TARGET}?`,
          `cloud-cli-Agent-Skill nach ${DEFAULT_SKILL_TARGET} schreiben?`,
        ),
        locale,
        true,
      )
    ) {
      targets.push(DEFAULT_SKILL_TARGET);
    }
    if (
      await confirmPluginInstall(
        text(locale, `Also to ${CLAUDE_SKILL_TARGET} for Claude Code?`, `Auch nach ${CLAUDE_SKILL_TARGET} für Claude Code?`),
        locale,
      )
    ) {
      targets.push(CLAUDE_SKILL_TARGET);
    }
  }
  return withConfigLock(async () => {
    const latest = await loadConfig();
    latest.skills = { targets };
    await saveConfig(latest);
    return latest;
  });
};

const noSkillTargetHint = (locale: string): string =>
  text(
    locale,
    `cld: no skill target chosen; run \`cld skills add ${DEFAULT_SKILL_TARGET}\` to write the cloud-cli skill for agents.`,
    `cld: kein Skill-Ziel gewählt; führe \`cld skills add ${DEFAULT_SKILL_TARGET}\` aus, um den cloud-cli-Skill für Agenten zu schreiben.`,
  );

type PluginCloud = { profile: string; server: string; fetch: (path: string, init?: RequestInit) => Promise<Response> };

/**
 * Authenticated access to a profile's Cloud. The current profile honours
 * --server, --token and the environment; other profiles use only their saved
 * configuration.
 */
const pluginCloud = async (global: GlobalArgs, otherProfile?: string): Promise<PluginCloud> => {
  const options =
    otherProfile === undefined
      ? await resolveOptions(global)
      : await resolveOptions({ ...global, profile: otherProfile }, { profileOnly: true });
  return { profile: options.profile, server: options.server, fetch: createContext([], {}, options).fetch };
};

type PluginChange = {
  profile: string;
  name: string;
  app: string;
  version: string;
  previous?: string;
  status: "installed" | "updated" | "unchanged" | "not served" | "failed";
  message?: string;
};

/**
 * Fetch, verify and lock plugins for one profile. Downloads run outside the
 * config lock; placing them in the store, updating the lock, and pruning
 * unused versions happen together under it.
 */
const syncProfilePlugins = async (
  cloud: PluginCloud,
  names: readonly string[],
  mode: "install" | "update",
  locale: string,
): Promise<PluginChange[]> => {
  const current = profileLock(await loadConfig(), cloud.profile);
  const changes: PluginChange[] = [];
  const staged: Array<{ name: string; locked: LockedPlugin; incoming: string | null }> = [];
  for (const name of names) {
    try {
      if (reservedNames.has(name)) throw new PluginError(`"${name}" is a built-in cld command`, "shadowed");
      if (!current[name] && (await loadPlugin(name).catch(() => null))) {
        throw new PluginError(`a package plugin "${name}" is installed for every profile; run \`cld plugins remove ${name}\` first`);
      }
      const manifest = await fetchPluginManifest(cloud.fetch, name);
      const previous = current[name];
      if (previous?.digest === manifest.digest && (await hasStoredPlugin(manifest.digest))) {
        changes.push({ profile: cloud.profile, name, app: manifest.app, version: manifest.version, status: "unchanged" });
        continue;
      }
      const download = (await hasStoredPlugin(manifest.digest))
        ? { incoming: null, module: await loadStoredPlugin(name, { ...manifest, summary: "" }) }
        : await downloadPlugin(cloud.fetch, manifest);
      staged.push({
        name,
        incoming: download.incoming,
        locked: { app: manifest.app, version: manifest.version, digest: manifest.digest, summary: download.module.summary },
      });
      changes.push({
        profile: cloud.profile,
        name,
        app: manifest.app,
        version: manifest.version,
        ...(previous ? { previous: previous.version } : {}),
        status: previous ? "updated" : "installed",
      });
    } catch (error) {
      if (!(error instanceof PluginError)) throw error;
      const notServed = mode === "update" && current[name] && error.message.startsWith("This Cloud serves no plugin");
      changes.push({
        profile: cloud.profile,
        name,
        app: current[name]?.app ?? "",
        version: current[name]?.version ?? "",
        status: notServed ? "not served" : "failed",
        message: error.message,
      });
    }
  }
  if (staged.length === 0) return changes;
  await withConfigLock(async () => {
    const config = await loadConfig();
    config.profiles ??= {};
    const profile = config.profiles[cloud.profile] ?? {};
    const lock = profileLock(config, cloud.profile);
    for (const { name, locked, incoming } of staged) {
      if (incoming) await placePlugin(incoming, locked.digest);
      lock[name] = locked;
    }
    config.profiles[cloud.profile] = { ...profile, plugins: lock };
    await saveConfig(config);
    await collectPluginGarbage(lockedDigests(config));
    await syncSkills(config, locale);
  });
  return changes;
};

const printPluginChanges = (changes: PluginChange[], output: GlobalArgs["output"], locale: string): number => {
  if (output === "jsonl") for (const change of changes) printLine(JSON.stringify(change));
  else if (output === "json") printLine(JSON.stringify({ plugins: changes }, null, 2));
  else {
    for (const change of changes) {
      const label = `${change.name} ${change.version}`.trim();
      const line =
        change.status === "installed"
          ? text(locale, `Installed ${label} (profile "${change.profile}").`, `${label} installiert (Profil "${change.profile}").`)
          : change.status === "updated"
            ? text(
                locale,
                `Updated ${change.name} ${change.previous} → ${change.version} (profile "${change.profile}").`,
                `${change.name} ${change.previous} → ${change.version} aktualisiert (Profil "${change.profile}").`,
              )
            : change.status === "unchanged"
              ? text(locale, `${label} is up to date (profile "${change.profile}").`, `${label} ist aktuell (Profil "${change.profile}").`)
              : undefined;
      if (line) printLine(line);
      else printErrorLine(`cld: ${change.name} (${change.profile}): ${change.message}`);
    }
  }
  return changes.some((change) => change.status === "failed") ? 1 : 0;
};

type PluginRow = {
  profile: string | null;
  name: string;
  app: string | null;
  installed: string | null;
  available: string | null;
  status: string;
  source: string;
};

const listProfilePlugins = async (global: GlobalArgs, profileName: string, current: boolean): Promise<PluginRow[]> => {
  const lock = profileLock(await loadConfig(), profileName);
  let available: CloudCliPluginSummary[] | null = null;
  const digests = new Map<string, string>();
  try {
    const cloud = await pluginCloud(global, current ? undefined : profileName);
    available = await fetchAvailablePlugins(cloud.fetch);
    await Promise.all(
      Object.keys(lock)
        .filter((name) => available?.some((plugin) => plugin.name === name))
        .map(async (name) => digests.set(name, (await fetchPluginManifest(cloud.fetch, name)).digest)),
    );
  } catch (error) {
    // A profile without a server has nothing to list; anything else is worth a warning.
    const unconfigured = error instanceof CliError && /No (server|token|login) configured/.test(error.message);
    if (!unconfigured) {
      printErrorLine(`cld: profile "${profileName}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const names = [...new Set([...Object.keys(lock), ...(available ?? []).map((plugin) => plugin.name)])].sort();
  return names.map((name) => {
    const locked = lock[name];
    const served = available?.find((plugin) => plugin.name === name);
    const status = !available
      ? "unknown"
      : !locked
        ? "available"
        : !served
          ? "not served"
          : digests.get(name) === locked.digest
            ? "ok"
            : "update available";
    return {
      profile: profileName,
      name,
      app: locked?.app ?? served?.app ?? null,
      installed: locked?.version ?? null,
      available: served?.version ?? null,
      status,
      source: "cloud",
    };
  });
};

const runPluginsCommand = async (args: string[], global: GlobalArgs): Promise<number> => {
  const locale = global.locale;
  if (args[0] === "run") {
    // Everything after the name belongs to the plugin; shadowing does not apply.
    const [, id, ...moduleArgs] = args;
    if (!id || id.startsWith("-")) {
      throw new CliError("Usage: cld plugins run <name> [args...]", 1, "Verwendung: cld plugins run <Name> [Argumente...]");
    }
    const module = await loadInstalledModule(id, global);
    if (!module) throw new CliError(`Plugin "${id}" is not installed.`, 1, `Plugin "${id}" ist nicht installiert.`);
    return runModule(module, moduleArgs, global);
  }
  const parsed = parseArgs(args, new Set([...BOOLEAN_FLAGS, "yes", "y", "all"]));
  const [command, ...targets] = parsed.args;
  if (!command) {
    printLine(pluginsHelp(locale));
    return 0;
  }
  const output = takeBooleanFlag(parsed.flags, "jsonl") ? "jsonl" : takeBooleanFlag(parsed.flags, "json") ? "json" : global.output;
  const allowed: Record<string, string[]> = {
    list: ["all"],
    install: ["all", "yes", "y"],
    update: ["all"],
    remove: [],
  };
  const allowedFlags = new Set(["json", "jsonl", ...(allowed[command] ?? [])]);
  const unsupportedFlag = Object.keys(parsed.flags).find((flag) => !allowedFlags.has(flag));
  if (unsupportedFlag) throw new CliError(`Unknown plugins option "--${unsupportedFlag}".`);
  const all = takeBooleanFlag(parsed.flags, "all");
  const printJson = (value: unknown) => printLine(output === "jsonl" ? JSON.stringify(value) : JSON.stringify(value, null, 2));

  if (command === "list" && targets.length === 0) {
    const config = await loadConfig();
    const currentProfile = resolveProfileName(config, global.profile);
    const profileNames = all ? Object.keys(config.profiles ?? {}).sort() : [currentProfile];
    const rows: PluginRow[] = [];
    for (const profileName of profileNames) rows.push(...(await listProfilePlugins(global, profileName, profileName === currentProfile)));
    const { plugins } = await loadPlugins(reservedNames);
    for (const plugin of plugins) {
      rows.push({
        profile: null,
        name: plugin.id,
        app: null,
        installed: plugin.version ?? null,
        available: null,
        status: plugin.status,
        source: plugin.source,
      });
    }
    if (output === "jsonl") for (const row of rows) printJson(row);
    else if (output === "json") printJson({ directory: pluginsDirectory(), plugins: rows });
    else if (rows.length === 0) {
      printLine(
        text(
          locale,
          `No plugins available for profile "${currentProfile}". Sign in with \`cld login\` to see your Cloud's plugins.`,
          `Keine Plugins für Profil "${currentProfile}" verfügbar. Melde dich mit \`cld login\` an, um die Plugins deiner Cloud zu sehen.`,
        ),
      );
    } else {
      printLine(
        renderTable(rows, [
          { key: "profile", label: text(locale, "PROFILE", "PROFIL"), value: (row) => row.profile ?? "*" },
          { key: "name", label: "NAME" },
          { key: "app", label: "APP", value: (row) => row.app ?? "-" },
          { key: "installed", label: text(locale, "INSTALLED", "INSTALLIERT"), value: (row) => row.installed ?? "-" },
          { key: "available", label: text(locale, "AVAILABLE", "VERFÜGBAR"), value: (row) => row.available ?? "-" },
          { key: "status", label: "STATUS" },
          { key: "source", label: text(locale, "SOURCE", "QUELLE") },
        ]),
      );
    }
    for (const plugin of plugins) if (plugin.status !== "ok") warnSkippedPlugin(plugin, locale);
    return 0;
  }

  if (command === "install" && targets.length === 1 && isPackagePluginSource(targets[0]!)) {
    const staged = await stagePlugin(targets[0]!).catch((error) =>
      pluginFailure(error, "Cannot install plugin", "Plugin kann nicht installiert werden"),
    );
    try {
      const { manifest, source } = staged;
      const label = `${manifest.package}@${manifest.version}`;
      printErrorLine(
        text(
          locale,
          `Plugin ${label} from ${source} runs inside cld with your Cloud credentials.`,
          `Plugin ${label} aus ${source} läuft in cld mit deinen Cloud-Zugangsdaten.`,
        ),
      );
      if (
        !takeBooleanFlag(parsed.flags, "yes", "y") &&
        !(await confirmPluginInstall(text(locale, "Install it?", "Installieren?"), locale))
      ) {
        printErrorLine(text(locale, "Plugin installation cancelled.", "Plugin-Installation abgebrochen."));
        return 1;
      }
      const config = await loadConfig();
      const { id, replaced } = await commitPlugin(staged, reservedNames, pluginsDirectory(), (id) => {
        const lockedBy = Object.keys(config.profiles ?? {}).filter((name) => profileLock(config, name)[id]);
        if (lockedBy.length > 0) {
          throw new PluginError(
            `profile "${lockedBy[0]}" already uses the Cloud's plugin "${id}"; run \`cld plugins remove ${id}\` there first`,
          );
        }
      }).catch((error) => pluginFailure(error, "Cannot install plugin", "Plugin kann nicht installiert werden"));
      if (output !== "text") {
        printJson({ id, package: manifest.package, version: manifest.version, source, replaced });
      } else {
        printLine(
          text(
            locale,
            `${replaced ? "Replaced" : "Installed"} plugin "${id}" (${label}). Run \`cld ${id} help\`.`,
            `Plugin "${id}" (${label}) ${replaced ? "ersetzt" : "installiert"}. Führe \`cld ${id} help\` aus.`,
          ),
        );
      }
      return 0;
    } finally {
      await staged.cleanup();
    }
  }

  if (command === "install" && (all ? targets.length === 0 : targets.length > 0)) {
    const invalid = targets.find((target) => !CLOUD_CLI_MODULE_NAME.test(target));
    if (invalid) {
      throw new CliError(
        `"${invalid}" is not a plugin name. Use ./path, a .tgz file, or npm:<package> for a package plugin.`,
        1,
        `"${invalid}" ist kein Plugin-Name. Nutze ./Pfad, eine .tgz-Datei oder npm:<Paket> für ein Paket-Plugin.`,
      );
    }
    const cloud = await pluginCloud(global);
    const lock = profileLock(await loadConfig(), cloud.profile);
    const names = all
      ? (
          await fetchAvailablePlugins(cloud.fetch).catch((error) =>
            pluginFailure(error, "Cannot install plugins", "Plugins können nicht installiert werden"),
          )
        )
          .map((plugin) => plugin.name)
          .filter((name) => !lock[name] && !reservedNames.has(name))
      : targets;
    if (names.length === 0) {
      if (output === "text") printLine(text(locale, "All plugins are installed.", "Alle Plugins sind installiert."));
      else printJson({ plugins: [] });
      return 0;
    }
    return printPluginChanges(await syncProfilePlugins(cloud, names, "install", locale), output, locale);
  }

  if (command === "update") {
    const config = await loadConfig();
    const currentProfile = resolveProfileName(config, global.profile);
    const profileNames = all ? Object.keys(config.profiles ?? {}).sort() : [currentProfile];
    const changes: PluginChange[] = [];
    for (const profileName of profileNames) {
      const lock = profileLock(config, profileName);
      const names = targets.length > 0 ? targets : Object.keys(lock).sort();
      const missing = names.find((name) => !lock[name]);
      if (missing) {
        throw new CliError(
          `Plugin "${missing}" is not installed for profile "${profileName}". Run \`cld plugins install ${missing}\`.`,
          1,
          `Plugin "${missing}" ist für Profil "${profileName}" nicht installiert. Führe \`cld plugins install ${missing}\` aus.`,
        );
      }
      if (names.length === 0) continue;
      const cloud = await pluginCloud(global, profileName === currentProfile ? undefined : profileName);
      changes.push(...(await syncProfilePlugins(cloud, names, "update", locale)));
    }
    if (changes.length === 0 && output === "text") {
      printLine(text(locale, "No plugins installed.", "Keine Plugins installiert."));
      return 0;
    }
    return printPluginChanges(changes, output, locale);
  }

  if (command === "remove" && targets.length === 1) {
    const name = targets[0]!;
    const config = await loadConfig();
    const profileName = resolveProfileName(config, global.profile);
    if (profileLock(config, profileName)[name]) {
      await withConfigLock(async () => {
        const latest = await loadConfig();
        const lock = profileLock(latest, profileName);
        delete lock[name];
        latest.profiles ??= {};
        latest.profiles[profileName] = { ...latest.profiles[profileName], plugins: lock };
        await saveConfig(latest);
        await collectPluginGarbage(lockedDigests(latest));
        await syncSkills(latest, global.locale);
      });
    } else if (!(await removePlugin(name))) {
      throw new CliError(`Plugin "${name}" is not installed.`, 1, `Plugin "${name}" ist nicht installiert.`);
    }
    if (output !== "text") printJson({ id: name, removed: true });
    else printLine(text(locale, `Removed plugin "${name}".`, `Plugin "${name}" entfernt.`));
    return 0;
  }

  throw new CliError(
    "Usage: cld plugins <list|install|update|remove|run>. Run `cld plugins help`.",
    1,
    "Verwendung: cld plugins <list|install|update|remove|run>. Führe `cld plugins help` aus.",
  );
};

const runProfileCommand = async (args: string[], locale: string): Promise<number> => {
  const [command, maybeName, ...rest] = args;
  if (!command) {
    printLine(profileHelp(locale));
    return 0;
  }

  const config = await loadConfig();
  config.profiles ??= {};

  if (command === "list") {
    const currentProfile = resolveProfileName(config, undefined);
    const rows = Object.entries(config.profiles).map(([name, profile]) => ({
      name,
      current: currentProfile === name ? "*" : "",
      server: profile.server ?? "",
      token: profile.token
        ? maskToken(profile.token)
        : profile.clientCredentials
          ? `client-credentials:${profile.clientCredentials.clientSecretFd0 ? "fd0" : "config"}`
          : profile.oauth
            ? `oauth:${profile.oauth.refreshTokenFd0 ? "fd0" : "config"}`
            : profile.fd0
              ? `fd0:${profile.fd0.name}`
              : profile.tokenFile
                ? `file:${profile.tokenFile}`
                : profile.tokenCommand
                  ? "command"
                  : "",
    }));
    printLine(
      renderTable(rows, [
        { key: "current", label: "" },
        { key: "name", label: text(locale, "PROFILE", "PROFIL") },
        { key: "server", label: "SERVER" },
        { key: "token", label: "TOKEN" },
      ]),
    );
    return 0;
  }

  if (command === "show") {
    const name = resolveProfileName(config, maybeName);
    const profile = config.profiles[name];
    if (!profile) throw new CliError(`Profile "${name}" does not exist.`);
    printLine(
      JSON.stringify(
        {
          name,
          current: resolveProfileName(config, undefined) === name,
          ...profile,
          token: maskToken(profile.token),
          oauth: profile.oauth
            ? {
                ...profile.oauth,
                accessToken: maskToken(profile.oauth.accessToken),
                refreshToken: maskToken(profile.oauth.refreshToken),
              }
            : undefined,
          clientCredentials: profile.clientCredentials
            ? { ...profile.clientCredentials, clientSecret: maskToken(profile.clientCredentials.clientSecret) }
            : undefined,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (command === "use") {
    if (!maybeName) throw new CliError("Missing profile name.");
    await withConfigLock(async () => {
      const latestConfig = await loadConfig();
      if (!latestConfig.profiles?.[maybeName]) throw new CliError(`Profile "${maybeName}" does not exist.`);
      latestConfig.currentProfile = maybeName;
      await saveConfig(latestConfig);
    });
    printLine(text(locale, `Using profile "${maybeName}".`, `Profil "${maybeName}" wird verwendet.`));
    return 0;
  }

  if (command === "set") {
    const name = maybeName && !maybeName.startsWith("-") ? maybeName : (config.currentProfile ?? DEFAULT_PROFILE);
    const flagArgs =
      maybeName && !maybeName.startsWith("-") ? rest : [maybeName, ...rest].filter((value): value is string => Boolean(value));
    const parsed = parseArgs(flagArgs);
    const server = takeStringFlag(parsed.flags, "server");
    const token = takeStringFlag(parsed.flags, "token");
    const tokenFile = takeStringFlag(parsed.flags, "token-file");
    const tokenCommand = takeStringFlag(parsed.flags, "token-command");
    const fd0 = takeStringFlag(parsed.flags, "fd0");
    const fd0Scope = takeStringFlag(parsed.flags, "fd0-scope");

    const setsAuthProvider = Boolean(token || tokenFile || tokenCommand || fd0);
    return withConfigLock(async () => {
      const latestConfig = await loadConfig();
      latestConfig.profiles ??= {};
      const existing = latestConfig.profiles[name] ?? {};
      if (existing.oauth && server && (!existing.server || canonicalServer(existing.server) !== canonicalServer(server))) {
        throw new CliError(
          `OAuth profile "${name}" is bound to ${existing.server ?? "an unknown server"}. Run \`cld login ${name}\` to change servers.`,
        );
      }

      let displacedRefreshToken: string | null = null;
      if (setsAuthProvider && existing.oauth) {
        try {
          displacedRefreshToken = await readOAuthRefreshToken(existing.oauth);
        } catch (error) {
          printErrorLine(`Warning: could not read replaced OAuth refresh token for remote revocation: ${(error as Error).message}`);
        }
      }

      const next: CloudCliProfile = {
        ...existing,
        ...(server ? { server: canonicalServer(server) } : {}),
      };
      delete next.token;
      delete next.tokenFile;
      delete next.tokenCommand;
      delete next.fd0;
      if (setsAuthProvider) {
        delete next.oauth;
        delete next.clientCredentials;
      }
      if (token) next.token = token;
      if (tokenFile) next.tokenFile = tokenFile;
      if (tokenCommand) next.tokenCommand = tokenCommand;
      if (fd0) next.fd0 = { name: fd0, ...(fd0Scope ? { scope: fd0Scope } : {}) };

      latestConfig.profiles[name] = next;
      latestConfig.currentProfile ??= name;
      await saveConfig(latestConfig);

      if (setsAuthProvider && existing.clientCredentials) await removeClientCredentials(existing.clientCredentials);
      if (setsAuthProvider && existing.oauth) {
        if (existing.server && displacedRefreshToken) {
          await revokeOAuthRefreshToken(existing.server, displacedRefreshToken).catch((error) => {
            printErrorLine(`Warning: failed to revoke the replaced OAuth login: ${(error as Error).message}`);
          });
        }
        const displacedFd0 = existing.oauth.refreshTokenFd0;
        const reusesDisplacedFd0 = displacedFd0 && next.fd0?.name === displacedFd0.name && next.fd0.scope === displacedFd0.scope;
        if (displacedFd0 && !reusesDisplacedFd0) await removeFd0Secret(displacedFd0.name, displacedFd0.scope);
      }

      printLine(text(locale, `Saved profile "${name}" to ${CONFIG_PATH}.`, `Profil "${name}" wurde unter ${CONFIG_PATH} gespeichert.`));
      return 0;
    });
  }

  throw new CliError(`Unknown profile command "${command}".`);
};

const base64UrlEncode = (bytes: Uint8Array): string => {
  const base64 = Buffer.from(bytes).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const randomBase64Url = (bytes: number): string => {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return base64UrlEncode(values);
};

const pkceChallenge = async (verifier: string): Promise<string> => {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(hash));
};

const openBrowser = async (url: string, locale: string): Promise<void> => {
  const opener =
    process.platform === "darwin"
      ? { command: "open", args: [url] }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };

  try {
    await execFileAsync(opener.command, opener.args, { timeout: 5_000 });
  } catch {
    printLine(text(locale, `Open this URL in your browser:\n${url}`, `Öffne diese URL im Browser:\n${url}`));
  }
};

const promptToOpenBrowser = async (url: string, signal: AbortSignal, locale: string): Promise<void> => {
  if (!process.stdin.isTTY) {
    printLine(
      text(
        locale,
        "Waiting for the OAuth callback. Open the URL above in a browser.",
        "Warte auf den OAuth-Callback. Öffne die URL oben in einem Browser.",
      ),
    );
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question(
      text(
        locale,
        "Press Enter to open this URL in your browser, or copy it into another browser.\n",
        "Drücke die Eingabetaste, um diese URL im Browser zu öffnen, oder kopiere sie in einen anderen Browser.\n",
      ),
      { signal },
    );
    await openBrowser(url, locale);
  } catch (error) {
    if ((error as { name?: string }).name !== "AbortError") {
      printErrorLine(`Warning: could not open browser: ${(error as Error).message}`);
    }
  } finally {
    rl.close();
  }
};

const oauthCallbackResponse = (message: string, status = 200): Response =>
  new Response(`${message}\n`, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });

const waitForOAuthCode = async (
  authorizationUrl: URL,
  expectedState: string,
  expectedIssuer: string,
  open: boolean,
  locale: string,
): Promise<string> => {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname !== "/callback") {
        return oauthCallbackResponse(
          text(locale, "This is not a Cloud CLI login callback.", "Dies ist kein Anmelde-Callback der Cloud CLI."),
          404,
        );
      }

      const state = url.searchParams.get("state");
      if (state !== expectedState) {
        return oauthCallbackResponse(
          text(
            locale,
            "Authentication failed: the OAuth callback did not match the expected state. You may close this window.",
            "Die Anmeldung ist fehlgeschlagen: Der OAuth-Callback entsprach nicht dem erwarteten Zustand. Du kannst dieses Fenster schließen.",
          ),
          400,
        );
      }

      if (url.searchParams.get("iss") !== expectedIssuer) {
        rejectCode(new CliError("OAuth callback did not match the expected issuer."));
        return oauthCallbackResponse(
          text(
            locale,
            "Authentication failed: the OAuth callback did not match the expected issuer. You may close this window.",
            "Die Anmeldung ist fehlgeschlagen: Der OAuth-Callback stammte nicht vom erwarteten Aussteller. Du kannst dieses Fenster schließen.",
          ),
          400,
        );
      }

      const error = url.searchParams.get("error");
      if (error) {
        const message = url.searchParams.get("error_description") ?? error;
        rejectCode(new CliError(message));
        return oauthCallbackResponse(
          text(
            locale,
            `Authentication failed: ${message}. You may close this window.`,
            `Die Anmeldung ist fehlgeschlagen: ${message}. Du kannst dieses Fenster schließen.`,
          ),
        );
      }

      const code = url.searchParams.get("code");
      if (!code) {
        rejectCode(new CliError("OAuth callback did not include an authorization code."));
        return oauthCallbackResponse(
          text(
            locale,
            "Authentication failed: the OAuth callback did not include an authorization code. You may close this window.",
            "Die Anmeldung ist fehlgeschlagen: Der OAuth-Callback enthielt keinen Autorisierungscode. Du kannst dieses Fenster schließen.",
          ),
          400,
        );
      }

      resolveCode(code);
      return oauthCallbackResponse(
        text(
          locale,
          "Authentication complete. You may close this window.",
          "Die Anmeldung ist abgeschlossen. Du kannst dieses Fenster schließen.",
        ),
      );
    },
  });

  authorizationUrl.searchParams.set("redirect_uri", `http://127.0.0.1:${server.port}/callback`);
  const timeout = setTimeout(() => rejectCode(new CliError("Timed out waiting for OAuth login callback.")), 5 * 60_000);
  const promptAbort = new AbortController();
  const url = authorizationUrl.toString();

  try {
    printLine(text(locale, `Login URL:\n${url}`, `Anmelde-URL:\n${url}`));
    if (!open || envLacksLocalBrowser()) {
      printLine(
        text(
          locale,
          "No browser on this machine (for example over SSH)? Press Ctrl+C and run `cld login --device` instead.",
          "Kein Browser auf diesem Rechner (zum Beispiel über SSH)? Drücke Strg+C und führe stattdessen `cld login --device` aus.",
        ),
      );
    }
    if (open) void promptToOpenBrowser(url, promptAbort.signal, locale);
    else
      printLine(
        text(
          locale,
          "Waiting for the OAuth callback. Open the URL above in a browser.",
          "Warte auf den OAuth-Callback. Öffne die URL oben in einem Browser.",
        ),
      );
    return await codePromise;
  } finally {
    promptAbort.abort();
    clearTimeout(timeout);
    server.stop(false);
  }
};

const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

type DeviceAuthorization = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
};

const parseDeviceAuthorization = (payload: unknown): DeviceAuthorization => {
  const value = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  if (
    typeof value.device_code !== "string" ||
    typeof value.user_code !== "string" ||
    typeof value.verification_uri !== "string" ||
    typeof value.expires_in !== "number" ||
    !(value.expires_in > 0) ||
    (value.interval !== undefined && (typeof value.interval !== "number" || !(value.interval > 0))) ||
    (value.verification_uri_complete !== undefined && typeof value.verification_uri_complete !== "string")
  ) {
    throw new CliError("OAuth server returned an invalid device authorization.");
  }
  return value as DeviceAuthorization;
};

const oauthErrorCode = async (response: Response): Promise<{ error: string; description?: string }> => {
  const payload = tryParseJson(await response.text().catch(() => ""));
  const value = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  return {
    error: typeof value.error === "string" ? value.error : String(response.status),
    ...(typeof value.error_description === "string" ? { description: value.error_description } : {}),
  };
};

/** RFC 8628: show a code, then poll until the person approves it in any browser. */
const signInWithDeviceCode = async (server: string, scope: string, locale: string): Promise<OAuthTokenResponse> => {
  const started = await fetchOAuth(joinUrl(server, "/oauth/device_authorization"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "accept-language": locale },
    body: new URLSearchParams({ client_id: OAUTH_CLIENT_ID, scope }),
  });
  if (started.status === 404) {
    throw new CliError(
      "This Cloud server does not support device sign-in yet. Update Cloud, or run `cld login` on a machine with a browser.",
      1,
      "Dieser Cloud-Server unterstützt die Geräteanmeldung noch nicht. Aktualisiere Cloud oder führe `cld login` auf einem Rechner mit Browser aus.",
    );
  }
  if (!started.ok) {
    const { error, description } = await oauthErrorCode(started);
    throw new CliError(
      `Device sign-in could not start: ${description ?? error}`,
      1,
      `Die Geräteanmeldung konnte nicht starten: ${description ?? error}`,
    );
  }
  const device = parseDeviceAuthorization(await readJson<unknown>(started));

  printLine(
    text(
      locale,
      `Open ${device.verification_uri} and enter the code: ${device.user_code}`,
      `Öffne ${device.verification_uri} und gib den Code ein: ${device.user_code}`,
    ),
  );
  if (device.verification_uri_complete) {
    printLine(text(locale, `(or open ${device.verification_uri_complete})`, `(oder öffne ${device.verification_uri_complete})`));
  }
  printLine(text(locale, "Waiting for approval…", "Warte auf Bestätigung…"));

  let intervalMs = (device.interval ?? 5) * 1_000;
  const deadline = Date.now() + device.expires_in * 1_000;
  while (Date.now() + intervalMs <= deadline) {
    await sleep(intervalMs);
    const response = await fetchOAuth(joinUrl(server, "/oauth/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: DEVICE_CODE_GRANT_TYPE, device_code: device.device_code, client_id: OAUTH_CLIENT_ID }),
    });
    if (response.ok) return readOAuthTokenResponse(response);
    const { error, description } = await oauthErrorCode(response);
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    if (error === "access_denied") {
      throw new CliError("Sign-in was denied in the browser.", 1, "Die Anmeldung wurde im Browser abgelehnt.");
    }
    if (error === "expired_token") break;
    throw new CliError(
      `Device sign-in failed: ${description ?? error}`,
      1,
      `Die Geräteanmeldung ist fehlgeschlagen: ${description ?? error}`,
    );
  }
  throw new CliError(
    "The code expired before it was approved. Run `cld login --device` again.",
    1,
    "Der Code ist abgelaufen, bevor er bestätigt wurde. Führe `cld login --device` erneut aus.",
  );
};

/** Display name from the ID token the server just returned; only used for the greeting. */
const signedInName = (idToken: unknown): string | null => {
  if (typeof idToken !== "string") return null;
  const payload = tryParseJson(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
  if (!payload || typeof payload !== "object") return null;
  const claims = payload as Record<string, unknown>;
  const name = typeof claims.name === "string" && claims.name.trim() ? claims.name : claims.uid;
  return typeof name === "string" && name.trim() ? name.trim() : null;
};

const signInWithBrowser = async (server: string, scope: string, open: boolean, locale: string): Promise<OAuthTokenResponse> => {
  const verifier = randomBase64Url(32);
  const state = randomBase64Url(24);

  const authorizationUrl = new URL(joinUrl(server, "/oauth/authorize"));
  authorizationUrl.searchParams.set("client_id", OAUTH_CLIENT_ID);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", scope);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", await pkceChallenge(verifier));
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("redirect_uri", "http://127.0.0.1/callback");
  authorizationUrl.searchParams.set("ui_locales", locale);

  const code = await waitForOAuthCode(authorizationUrl, state, server, open, locale);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: OAUTH_CLIENT_ID,
    code,
    redirect_uri: authorizationUrl.searchParams.get("redirect_uri") ?? "",
    code_verifier: verifier,
  });
  return readOAuthTokenResponse(
    await fetchOAuth(joinUrl(server, "/oauth/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
  );
};

/** Store a fresh OAuth login in the profile, replacing and revoking the previous one. */
const storeOAuthLogin = async (params: {
  name: string;
  server: string;
  token: OAuthTokenResponse & { refresh_token: string };
  scope: string;
  fd0Name: string | undefined;
  fd0Scope: string | undefined;
}): Promise<void> => {
  const { name, server: normalizedServer, token, scope, fd0Name, fd0Scope } = params;
  let persisted = false;
  try {
    await withConfigLock(async () => {
      const latestConfig = await loadConfig();
      const latestProfile = latestConfig.profiles?.[name] ?? {};
      const displacedSession = latestProfile.oauth;
      let displacedRefreshToken: string | null = null;
      if (displacedSession) {
        try {
          displacedRefreshToken = await readOAuthRefreshToken(displacedSession);
        } catch (error) {
          throw new CliError(`Could not replace the existing OAuth login: ${(error as Error).message}`);
        }
      }

      const refreshTokenFd0 = fd0Name ? { name: fd0Name, ...(fd0Scope ? { scope: fd0Scope } : {}) } : undefined;
      const baseSession: OAuthSessionConfig = {
        accessToken: token.access_token,
        accessTokenExpiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
        scope: token.scope ?? scope,
        ...(refreshTokenFd0 ? { refreshTokenFd0 } : {}),
      };

      let storedInFd0 = false;
      try {
        const oauth = await writeOAuthRefreshToken(baseSession, token.refresh_token);
        storedInFd0 = Boolean(refreshTokenFd0);
        const next: CloudCliProfile = {
          ...latestProfile,
          server: normalizedServer,
          oauth,
        };
        delete next.token;
        delete next.tokenFile;
        delete next.tokenCommand;
        delete next.fd0;

        latestConfig.profiles ??= {};
        latestConfig.profiles[name] = next;
        latestConfig.currentProfile = name;
        await saveConfig(latestConfig);
        persisted = true;
      } catch (error) {
        if (storedInFd0 && refreshTokenFd0) {
          const displacedFd0 = displacedSession?.refreshTokenFd0;
          const replacedDisplacedSecret = displacedFd0?.name === refreshTokenFd0.name && displacedFd0.scope === refreshTokenFd0.scope;
          if (replacedDisplacedSecret && displacedRefreshToken !== null) {
            await writeFd0Secret(refreshTokenFd0.name, refreshTokenFd0.scope, displacedRefreshToken).catch((restoreError) => {
              printErrorLine(`Warning: failed to restore the previous fd0 refresh token: ${(restoreError as Error).message}`);
            });
          } else {
            await removeFd0Secret(refreshTokenFd0.name, refreshTokenFd0.scope);
          }
        }
        throw error;
      }

      if (displacedRefreshToken && latestProfile.server && displacedSession) {
        await revokeOAuthRefreshToken(latestProfile.server, displacedRefreshToken).catch((error) => {
          printErrorLine(`Warning: failed to revoke the previous OAuth login: ${(error as Error).message}`);
        });
      }
      const displacedFd0 = displacedSession?.refreshTokenFd0;
      const reusesDisplacedFd0 =
        displacedFd0 && refreshTokenFd0 && displacedFd0.name === refreshTokenFd0.name && displacedFd0.scope === refreshTokenFd0.scope;
      if (displacedFd0 && !reusesDisplacedFd0) {
        await removeFd0Secret(displacedFd0.name, displacedFd0.scope);
      }
    });
  } catch (error) {
    if (!persisted) {
      await revokeOAuthRefreshToken(normalizedServer, token.refresh_token).catch((revokeError) => {
        printErrorLine(`Warning: failed to revoke the unpersisted OAuth login: ${(revokeError as Error).message}`);
      });
    }
    throw error;
  }
};

const runLoginCommand = async (args: string[], global: GlobalArgs): Promise<number> => {
  const [maybeName, ...rest] = args;
  const config = await loadConfig();
  const name = maybeName && !maybeName.startsWith("-") ? maybeName : (global.profile ?? config.currentProfile ?? DEFAULT_PROFILE);
  const flagArgs = maybeName && !maybeName.startsWith("-") ? rest : [maybeName, ...rest].filter((value): value is string => Boolean(value));
  const parsed = parseArgs(flagArgs, new Set([...BOOLEAN_FLAGS, "no-open", "device", "yes", "y", "no-plugins"]));
  if ("client-id" in parsed.flags) {
    throw new CliError('cld login always uses the first-party "cloud-cli" OAuth client; --client-id is not supported.');
  }
  const existing = config.profiles?.[name] ?? {};
  const server = takeStringFlag(parsed.flags, "server") ?? global.server ?? envServer() ?? existing.server;
  if (!server) throw new CliError("Missing server. Run `cld login --server <url>`.");

  const scope = takeStringFlag(parsed.flags, "scope") ?? DEFAULT_OAUTH_SCOPE;
  const fd0Flag = parsed.flags.fd0;
  const fd0Name = typeof fd0Flag === "string" ? fd0Flag : fd0Flag === true ? `cloud-${name}-oauth-refresh-token` : undefined;
  const fd0Scope = takeStringFlag(parsed.flags, "fd0-scope") ?? global.fd0Scope;
  const normalizedServer = canonicalServer(server);
  const device = takeBooleanFlag(parsed.flags, "device");

  const token = device
    ? await signInWithDeviceCode(normalizedServer, scope, global.locale)
    : await signInWithBrowser(normalizedServer, scope, !takeBooleanFlag(parsed.flags, "no-open"), global.locale);
  const refreshToken = token.refresh_token;
  if (!refreshToken) throw new CliError("OAuth server did not issue a refresh token. Check the offline_access scope.");

  await storeOAuthLogin({ name, server: normalizedServer, token: { ...token, refresh_token: refreshToken }, scope, fd0Name, fd0Scope });

  const displayName = device ? signedInName(token.id_token) : null;
  printLine(
    displayName
      ? text(global.locale, `✓ Signed in as ${displayName} (profile "${name}")`, `✓ Angemeldet als ${displayName} (Profil "${name}")`)
      : text(
          global.locale,
          `Logged in to ${normalizedServer} as profile "${name}".`,
          `Bei ${normalizedServer} als Profil "${name}" angemeldet.`,
        ),
  );
  const yes = takeBooleanFlag(parsed.flags, "yes", "y");
  if (!takeBooleanFlag(parsed.flags, "no-plugins")) await offerCloudPlugins({ ...global, profile: name }, yes);
  const asked = await offerSkillTargets(global.locale, yes);
  if (asked) {
    for (const path of await syncSkills(asked, global.locale))
      printLine(text(global.locale, `Wrote the cloud-cli skill to ${path}.`, `cloud-cli-Skill nach ${path} geschrieben.`));
  }
  return 0;
};

/**
 * After a login, offer the plugins this Cloud serves that the profile does
 * not have yet. Never fails the login: problems become one stderr line.
 */
const offerCloudPlugins = async (global: GlobalArgs, yes: boolean): Promise<void> => {
  const locale = global.locale;
  try {
    const cloud = await pluginCloud({ ...global, server: undefined, token: undefined }, global.profile);
    const lock = profileLock(await loadConfig(), cloud.profile);
    const missing = (await fetchAvailablePlugins(cloud.fetch))
      .map((plugin) => plugin.name)
      .filter((name) => !lock[name] && !reservedNames.has(name));
    if (missing.length === 0) return;
    const list = missing.join(", ");
    if (!yes) {
      if (!process.stdin.isTTY) {
        printErrorLine(
          text(
            locale,
            `This Cloud serves ${missing.length} cld plugin(s): ${list}. Run \`cld plugins install --all\` to install them.`,
            `Diese Cloud stellt ${missing.length} cld-Plugin(s) bereit: ${list}. Führe \`cld plugins install --all\` aus, um sie zu installieren.`,
          ),
        );
        return;
      }
      const question = text(
        locale,
        `This Cloud serves ${missing.length} cld plugin(s): ${list}. Install them?`,
        `Diese Cloud stellt ${missing.length} cld-Plugin(s) bereit: ${list}. Installieren?`,
      );
      if (!(await confirmPluginInstall(question, locale, true))) return;
    }
    printPluginChanges(await syncProfilePlugins(cloud, missing, "install", locale), "text", locale);
  } catch (error) {
    printErrorLine(
      text(
        locale,
        `cld: plugins not installed: ${error instanceof Error ? error.message : String(error)}`,
        `cld: Plugins nicht installiert: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
};

const runLogoutCommand = async (args: string[], global: GlobalArgs): Promise<number> => {
  const parsed = parseArgs(args);
  const config = await loadConfig();
  const name = takeStringFlag(parsed.flags, "profile", "p") ?? global.profile ?? resolveProfileName(config, undefined);
  return withConfigLock(async () => {
    const latestConfig = await loadConfig();
    const profile = latestConfig.profiles?.[name];
    if (profile?.clientCredentials) {
      await removeClientCredentials(profile.clientCredentials);
      delete profile.clientCredentials;
      delete profile.oauth;
      await saveConfig(latestConfig);
      printLine(
        text(
          global.locale,
          `Removed the client credentials from profile "${name}". The agent's client stays valid until an administrator revokes it.`,
          `Client-Zugangsdaten aus Profil "${name}" entfernt. Der Client des Agents bleibt gültig, bis ein Administrator ihn widerruft.`,
        ),
      );
      return 0;
    }
    if (!profile?.oauth) {
      printLine(text(global.locale, `Profile "${name}" is not logged in with OAuth.`, `Profil "${name}" ist nicht über OAuth angemeldet.`));
      return 0;
    }

    let refreshToken: string | null = null;
    try {
      refreshToken = await readOAuthRefreshToken(profile.oauth);
    } catch (error) {
      printErrorLine(`Warning: could not read refresh token for remote revocation: ${(error as Error).message}`);
    }

    if (profile.server && refreshToken) {
      await revokeOAuthRefreshToken(profile.server, refreshToken).catch((error) => {
        printErrorLine(`Warning: ${(error as Error).message} Removing local credentials anyway.`);
      });
    }

    if (profile.oauth.refreshTokenFd0) {
      await removeFd0Secret(profile.oauth.refreshTokenFd0.name, profile.oauth.refreshTokenFd0.scope);
    }
    delete profile.oauth;
    await saveConfig(latestConfig);
    printLine(text(global.locale, `Logged out profile "${name}".`, `Profil "${name}" wurde abgemeldet.`));
    return 0;
  });
};

const runAuthCommand = async (args: string[], global: GlobalArgs): Promise<number> => {
  const [maybeCommand = "status", ...rest] = args;
  const command = maybeCommand.startsWith("-") ? "status" : maybeCommand;
  if (command !== "status") throw new CliError(`Unknown auth command "${command}".`);
  const parsed = parseArgs(maybeCommand.startsWith("-") ? args : rest, new Set([...BOOLEAN_FLAGS]));

  const config = await loadConfig();
  const name = takeStringFlag(parsed.flags, "profile", "p") ?? global.profile ?? resolveProfileName(config, undefined);
  const profile = config.profiles?.[name];
  const payload = {
    profile: name,
    server: profile?.server ?? "",
    kind: profile?.clientCredentials
      ? "client-credentials"
      : profile?.oauth
        ? "oauth"
        : profile?.token
          ? "token"
          : profile?.fd0
            ? "fd0"
            : profile?.tokenFile
              ? "token-file"
              : profile?.tokenCommand
                ? "token-command"
                : "none",
    accessTokenExpiresAt: profile?.oauth?.accessTokenExpiresAt ?? null,
    refreshTokenStorage: profile?.oauth?.refreshTokenFd0 ? `fd0:${profile.oauth.refreshTokenFd0.name}` : profile?.oauth ? "config" : null,
    clientId: profile?.clientCredentials?.clientId ?? null,
    clientSecretStorage: profile?.clientCredentials
      ? profile.clientCredentials.clientSecretFd0
        ? `fd0:${profile.clientCredentials.clientSecretFd0.name}`
        : "config"
      : null,
  };

  if (global.output === "json" || takeBooleanFlag(parsed.flags, "json")) printLine(JSON.stringify(payload, null, 2));
  else {
    printLine(`${text(global.locale, "Profile", "Profil")}: ${payload.profile}`);
    printLine(`Server: ${payload.server || "-"}`);
    printLine(`${text(global.locale, "Auth", "Authentifizierung")}: ${payload.kind}`);
    if (payload.accessTokenExpiresAt)
      printLine(`${text(global.locale, "Access token expires", "Access-Token läuft ab")}: ${payload.accessTokenExpiresAt}`);
    if (payload.refreshTokenStorage)
      printLine(`${text(global.locale, "Refresh token storage", "Speicherort des Refresh-Tokens")}: ${payload.refreshTokenStorage}`);
    if (payload.clientId) printLine(`${text(global.locale, "OAuth client", "OAuth-Client")}: ${payload.clientId}`);
    if (payload.clientSecretStorage)
      printLine(`${text(global.locale, "Client secret storage", "Speicherort des Client-Secrets")}: ${payload.clientSecretStorage}`);
  }
  return 0;
};

const runVersionCommand = async (args: string[]): Promise<number> => {
  if (args.length > 0) throw new CliError("Usage: cld version", 1, "Verwendung: cld version");
  printLine(`cld ${cliVersion} (${cliCommit})`);
  return 0;
};

type CoreCommand = {
  help: (locale: string) => string;
  run: (args: string[], global: GlobalArgs) => Promise<number>;
  /** Flags the command reads a value from, so `--profile help` names a profile instead of asking for help. */
  valueFlags?: readonly string[];
};

/** The built-in commands besides `help`. `main` answers a help request before a command reads or changes anything. */
const coreCommands = new Map<string, CoreCommand>([
  ["login", { help: loginHelp, run: runLoginCommand, valueFlags: ["server", "scope", "fd0", "fd0-scope"] }],
  ["logout", { help: logoutHelp, run: runLogoutCommand, valueFlags: ["profile", "p"] }],
  ["auth", { help: authHelp, run: runAuthCommand, valueFlags: ["profile", "p"] }],
  [
    "profile",
    {
      help: profileHelp,
      run: (args, global) => runProfileCommand(args, global.locale),
      valueFlags: ["server", "token", "token-file", "token-command", "fd0", "fd0-scope"],
    },
  ],
  ["update", { help: updateHelp, run: (args, global) => runUpdateCommand(args, global.locale), valueFlags: ["version", "skills-dir"] }],
  ["plugins", { help: pluginsHelp, run: runPluginsCommand }],
  ["skills", { help: skillsHelp, run: runSkillsCommand }],
  ["version", { help: versionHelp, run: runVersionCommand }],
]);

/**
 * A core command asks for help like a module command: `-h` or `--help`
 * anywhere, `help` as the first argument, or `help` as the last argument
 * unless it is the value of the flag before it. Everything after
 * `cld plugins run <name>` belongs to the plugin, which answers its own help.
 */
const isCoreHelpRequest = (command: string, core: CoreCommand, args: readonly string[]): boolean => {
  const own = command === "plugins" && args[0] === "run" ? args.slice(0, 2) : args;
  if (own.some((arg) => /^-+(h|help)$/.test(arg)) || own[0] === "help") return true;
  const previous = own.at(-2) ?? "";
  const flagValue = previous.startsWith("-") && (core.valueFlags ?? []).includes(previous.replace(/^-+/, ""));
  return own.at(-1) === "help" && !flagValue;
};

export const main = async (argv = Bun.argv.slice(2)): Promise<number> => {
  if (argv.length === 1 && ["--version", "-V", "version"].includes(argv[0]!)) {
    printLine(`cld ${cliVersion} (${cliCommit})`);
    return 0;
  }
  const global = parseGlobalArgs(argv);
  const [moduleName, ...commandArgs] = global.rest;
  // `cld --help <command> ...` asks for the same help as `cld <command> --help`.
  const moduleArgs = global.help ? ["--help"] : commandArgs;

  if (!moduleName || moduleName === "help" || moduleName === "--help" || moduleName === "-h") {
    const { modules: pluginModules, plugins } = await loadPlugins(reservedNames);
    for (const plugin of plugins) if (plugin.status !== "ok") warnSkippedPlugin(plugin, global.locale);
    const config = await loadConfig();
    const served = Object.entries(profileLock(config, resolveProfileName(config, global.profile)))
      .filter(([name]) => !reservedNames.has(name))
      .map(([name, locked]) => ({ name, summary: locked.summary }));
    printLine(
      helpText(
        global.locale,
        [...served, ...pluginModules].sort((left, right) => left.name.localeCompare(right.name)),
      ),
    );
    return 0;
  }

  const core = coreCommands.get(moduleName);
  if (core) {
    if (!isCoreHelpRequest(moduleName, core, moduleArgs)) return core.run(moduleArgs, global);
    printLine(core.help(global.locale));
    return 0;
  }

  if (moduleArgs[0] === "reference" && !reservedNames.has(moduleName)) {
    const locked = await lockedPlugin(moduleName, global);
    if (locked) return runReferenceCommand(moduleName, locked, moduleArgs.slice(1));
  }
  const module = reservedNames.has(moduleName) ? undefined : await loadInstalledModule(moduleName, global);
  if (!module) {
    if (CLOUD_CLI_MODULE_NAME.test(moduleName)) {
      throw new CliError(
        `Unknown command "${moduleName}". If your Cloud serves it, run \`cld plugins install ${moduleName}\`; \`cld plugins list\` shows what it serves.`,
        1,
        `Unbekannter Befehl "${moduleName}". Wenn deine Cloud ihn bereitstellt, führe \`cld plugins install ${moduleName}\` aus; \`cld plugins list\` zeigt, was sie bereitstellt.`,
      );
    }
    throw new CliError(
      `Unknown module "${moduleName}". Run \`cld help\`.`,
      1,
      `Unbekanntes Modul "${moduleName}". Führe \`cld help\` aus.`,
    );
  }

  return runModule(module, moduleArgs, global);
};

const wantsJsonError = (argv: string[]): boolean => argv.includes("--json") || argv.includes("--jsonl");

const errorPayload = (error: unknown, exitCode: number) => {
  const message = error instanceof Error ? error.message : String(error);
  const statusMatch = message.match(/^(\d{3})\s+(.+)$/);
  return {
    error: {
      message: statusMatch?.[2] ?? message,
      ...(statusMatch ? { status: Number.parseInt(statusMatch[1]!, 10) } : {}),
      exitCode,
    },
  };
};

if (import.meta.main) {
  // A reader that stops early (`cld … | head`) wants no more output; that is not a crash.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error;
    });
  }
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      const exitCode = error instanceof CliError ? error.exitCode : 1;
      if (wantsJsonError(Bun.argv.slice(2))) {
        const payload = errorPayload(error, exitCode);
        printErrorLine(Bun.argv.includes("--jsonl") ? JSON.stringify(payload) : JSON.stringify(payload, null, 2));
      } else {
        let locale = "en";
        try {
          locale = parseGlobalArgs(Bun.argv.slice(2)).locale;
        } catch {
          locale = envLocale() ?? "en";
        }
        printErrorLine(error instanceof CliError ? error.localizedMessage(locale) : error instanceof Error ? error.message : String(error));
      }
      process.exitCode = exitCode;
    },
  );
}
