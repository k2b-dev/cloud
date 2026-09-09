#!/usr/bin/env bun
import { exec, execFile, spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import type {
  CloudCliContext,
  CloudCliFlags,
  CloudCliFlagValue,
  CloudCliModule,
  CloudCliOptions,
  CloudCliTableColumn,
} from "@valentinkolb/cloud/cli";
import { localizeCloudCliText, resolveCloudCliLocale } from "@valentinkolb/cloud/cli";
import accountCliModule from "@valentinkolb/cloud/cli/account";
import adminCliModule from "@valentinkolb/cloud/cli/admin";
import appsCliModule from "@valentinkolb/cloud/cli/apps";
import capabilitiesCliModule from "@valentinkolb/cloud/cli/capabilities";
import accountsCliModule from "@valentinkolb/cloud-app-accounts/cli";
import apiDocsCliModule from "@valentinkolb/cloud-app-api-docs/cli";
import assistantCliModule from "@valentinkolb/cloud-app-assistant/cli";
import contactsCliModule from "@valentinkolb/cloud-app-contacts/cli";
import kitCliModule from "@valentinkolb/cloud-app-kit/cli";
import faqCliModule from "@valentinkolb/cloud-app-faq/cli";
import gridsCliModule from "@valentinkolb/cloud-app-grids/cli";
import ipaHostsCliModule from "@valentinkolb/cloud-app-ipa-hosts/cli";
import mailCliModule from "@valentinkolb/cloud-app-mail/cli";
import notebooksCliModule from "@valentinkolb/cloud-app-notebooks/cli";
import oauthCliModule from "@valentinkolb/cloud-app-oauth/cli";
import pulseCliModule from "@valentinkolb/cloud-app-pulse/cli";
import spacesCliModule from "@valentinkolb/cloud-app-spaces/cli";
import toolsCliModule from "@valentinkolb/cloud-app-tools/cli";
import venueCliModule from "@valentinkolb/cloud-app-venue/cli";
import type { Hono } from "hono";
import { hc } from "hono/client";
import { defaultCloudCliSkillsDir, updateCli } from "./release";

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

type CloudCliProfile = TokenProviderConfig & {
  server?: string;
  defaults?: Record<string, string>;
  oauth?: OAuthSessionConfig;
};

type CloudCliConfig = {
  currentProfile?: string;
  profiles?: Record<string, CloudCliProfile>;
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
  rest: string[];
};

const DEFAULT_PROFILE = "default";
const OAUTH_CLIENT_ID = "cloud-cli";
const DEFAULT_OAUTH_SCOPE = "openid profile email offline_access read write";
const CONFIG_PATH =
  process.env.CLD_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cloud", "cld", "config.json");
const TOKEN_TIMEOUT_MS = 10_000;
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;
const OAUTH_REFRESH_SKEW_MS = 60_000;
const PROFILE_LOCK_TIMEOUT_MS = 15_000;
const PROFILE_LOCK_STALE_MS = 60_000;
const BOOLEAN_FLAGS = new Set(["json", "jsonl"]);

const cliVersion = typeof __CLD_VERSION__ === "string" ? __CLD_VERSION__ : "0.0.0-dev";
const cliCommit = typeof __CLD_COMMIT__ === "string" ? __CLD_COMMIT__ : "unknown";

const modules: CloudCliModule[] = [
  accountCliModule,
  accountsCliModule,
  adminCliModule,
  apiDocsCliModule,
  appsCliModule,
  capabilitiesCliModule,
  assistantCliModule,
  contactsCliModule,
  faqCliModule,
  kitCliModule,
  gridsCliModule,
  ipaHostsCliModule,
  mailCliModule,
  notebooksCliModule,
  oauthCliModule,
  pulseCliModule,
  spacesCliModule,
  toolsCliModule,
  venueCliModule,
];

const moduleByName = new Map(modules.map((module) => [module.name, module]));

const text = (locale: string, en: string, de: string): string => localizeCloudCliText(locale, { en, de });

const germanModuleSummaries = new Map<string, string>([
  ["account", "Eigenes Konto verwalten."],
  ["accounts", "Konten, Gruppen und Zugriffe verwalten."],
  ["admin", "Cloud-Betrieb verwalten."],
  ["api-docs", "Registrierte HTTP-APIs untersuchen."],
  ["apps", "Installierte Anwendungen anzeigen."],
  ["capabilities", "Registrierte Capabilities untersuchen und ausführen."],
  ["assistant", "Mit Assistant arbeiten."],
  ["contacts", "Kontakte verwalten."],
  ["faq", "FAQ-Einträge verwalten."],
  ["kit", "Lokale Browser-Werkzeuge erstellen und teilen."],
  ["grids", "Grids-Daten und -Konfiguration verwalten."],
  ["ipa-hosts", "FreeIPA-Hosts verwalten."],
  ["mail", "Mail verwalten."],
  ["notebooks", "Notizbücher und Notizen verwalten."],
  ["oauth", "OAuth-Clients verwalten."],
  ["pulse", "Pulse-Daten und -Dashboards verwalten."],
  ["spaces", "Spaces und Arbeitselemente verwalten."],
  ["tools", "Lokale Cloud-Werkzeuge verwenden."],
  ["venue", "Veranstaltungsorte verwalten."],
]);

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

const isFlag = (value: string | undefined): boolean => Boolean(value?.startsWith("-"));

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
  const requestedLocale = takeStringFlag(parsed.flags, "locale") ?? process.env.CLD_LOCALE;
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
    rest,
  };
};

const maskToken = (token: string | undefined): string | undefined => {
  if (!token) return undefined;
  if (token.length <= 16) return "********";
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
};

const hasPersistentTokenProvider = (profile: CloudCliProfile): boolean =>
  Boolean(profile.token || profile.tokenFile || profile.tokenCommand || profile.fd0 || profile.oauth);

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
    child.stdin.end(value);
  });
};

const removeFd0Secret = async (name: string, scope: string | undefined): Promise<void> => {
  const args = ["rm", name, "--yes"];
  if (scope) args.push("--scope", scope);
  try {
    await execFileAsync("fd0", args, { timeout: TOKEN_TIMEOUT_MS });
  } catch (error) {
    console.error(`Warning: failed to remove OAuth refresh token from fd0: ${error instanceof Error ? error.message : String(error)}`);
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
        console.error(`Warning: refreshed OAuth token, but failed to persist profile metadata: ${(error as Error).message}`);
        return token.access_token;
      }

      await revokeOAuthRefreshToken(server, token.refresh_token).catch((revokeError) => {
        console.error(`Warning: failed to revoke unpersisted refresh token: ${(revokeError as Error).message}`);
      });
      await removeLocalOAuthSession(profileName).catch((removeError) => {
        console.error(`Warning: failed to remove invalid local OAuth session: ${(removeError as Error).message}`);
      });
      throw error;
    }

    return token.access_token;
  });

const resolveAuth = async (
  global: GlobalArgs,
  config: CloudCliConfig,
  profileName: string,
  profile: CloudCliProfile,
  server: string,
): Promise<ResolvedAuth> => {
  if (global.token) return { token: global.token };
  if (process.env.CLD_TOKEN) return { token: process.env.CLD_TOKEN };
  if (global.tokenFile) return { token: await readTokenFile(global.tokenFile) };
  if (global.fd0) return { token: await readFd0Token(global.fd0, global.fd0Scope) };
  if (global.tokenCommand) return { token: await readCommandToken(global.tokenCommand) };
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

const resolveOptions = async (global: GlobalArgs): Promise<ResolvedCliOptions> => {
  const config = await loadConfig();
  const profileName = resolveProfileName(config, global.profile);
  const profile = config.profiles?.[profileName] ?? {};
  const server = global.server ?? process.env.CLD_SERVER ?? profile.server;
  if (!server)
    throw new CliError(
      "No server configured. Pass --server or run `cld profile set --server <url>`.",
      1,
      "Kein Server konfiguriert. Übergib --server oder führe `cld profile set --server <URL>` aus.",
    );
  const normalizedServer = canonicalServer(server);
  const auth = await resolveAuth(global, config, profileName, profile, normalizedServer);
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
  const server = global.server ?? process.env.CLD_SERVER ?? profile.server ?? "";
  return {
    profile: profileName,
    server: server ? normalizeServer(server) : "",
    token: global.token ?? process.env.CLD_TOKEN ?? profile.token ?? "",
    output: global.output,
    locale: global.locale,
  };
};

const readJson = async <T>(response: Response): Promise<T> => {
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
        console.error(
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
      console.log(value);
    },
    write: (value) =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(value, (error) => (error ? reject(error) : resolve()));
      }),
    error: (value) => {
      console.error(value);
    },
    json: (value) => {
      console.log(JSON.stringify(value, null, 2));
    },
    jsonLine: (value) => {
      console.log(JSON.stringify(value));
    },
    table: (rows, columns) => {
      const rendered = renderTable(rows, columns);
      if (rendered) console.log(rendered);
    },
  };
};

const helpText = (locale: string): string =>
  text(
    locale,
    `cld

Usage:
  cld [global options] <module> <command> [options]
  cld login [profile] --server <url>
  cld logout [--profile <name>]
  cld auth status
  cld profile <list|show|use|set> [options]
  cld update [--version <version>] [--yes] [--no-verify]
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

Modules:
${modules.map((module) => `  ${module.name.padEnd(12)} ${module.summary}`).join("\n")}

Examples:
  cld login --server http://localhost:3000
  cld --server http://localhost:3000 --token cld_... notebooks list
  cld profile set --server http://localhost:3000 --fd0 cloud-local-token --fd0-scope stuve
  cld notebooks tree <notebook>
`,
    `cld

Verwendung:
  cld [globale Optionen] <Modul> <Befehl> [Optionen]
  cld login [Profil] --server <URL>
  cld logout [--profile <Name>]
  cld auth status
  cld profile <list|show|use|set> [Optionen]
  cld update [--version <Version>] [--yes] [--no-verify]
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

Module:
${modules.map((module) => `  ${module.name.padEnd(12)} ${germanModuleSummaries.get(module.name) ?? module.summary}`).join("\n")}

Beispiele:
  cld login --server http://localhost:3000
  cld --server http://localhost:3000 --token cld_... notebooks list
  cld profile set --server http://localhost:3000 --fd0 cloud-local-token --fd0-scope stuve
  cld notebooks tree <notebook>
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
  --yes                Skip the confirmation prompt
  --no-verify          Skip optional Cosign verification; SHA-256 is always verified
  --no-skills          Skip updating the Cloud CLI agent skill
  --skills-dir <dir>   Skill install base directory (default: ${defaultCloudCliSkillsDir()})
  --claude-symlink     Link the installed skill into ~/.claude/skills/cloud-cli
`,
    `cld update

Verwendung:
  cld update [--version <Version>] [--yes] [--no-verify] [--no-skills] [--skills-dir <Verzeichnis>] [--claude-symlink]

Optionen:
  --version <Version>  cli-vX.Y.Z oder X.Y.Z installieren (Standard: neuestes CLI-Release)
  --yes                Bestätigungsabfrage überspringen
  --no-verify          Optionale Cosign-Prüfung überspringen; SHA-256 wird immer geprüft
  --no-skills          Aktualisierung des Cloud-CLI-Agent-Skills überspringen
  --skills-dir <Pfad>  Basisverzeichnis für Skills (Standard: ${defaultCloudCliSkillsDir()})
  --claude-symlink     Installierten Skill unter ~/.claude/skills/cloud-cli verlinken
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
  if (isModuleHelpRequest(parsed.args, parsed.flags)) {
    console.log(updateHelp(locale));
    return 0;
  }
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
  const result = await updateCli({
    version,
    verifyCosign: !noVerify,
    installSkill: !noSkills,
    skillsDir,
    claudeSymlink,
    confirm: yes ? undefined : confirmCliUpdate,
  });
  const claude =
    result.claudeSymlink === "created"
      ? "; Claude Code symlink created"
      : result.claudeSymlink === "exists"
        ? "; Claude Code symlink already linked"
        : result.claudeSymlink === "blocked"
          ? "; Claude Code symlink skipped because the target already exists"
          : "";
  if (result.release.version === cliVersion) {
    console.log(
      result.skill === "installed"
        ? `cld ${cliVersion} is up to date; Cloud CLI skill updated${claude}.`
        : `cld ${cliVersion} is already up to date${claude}.`,
    );
    return 0;
  }
  const verification =
    result.cosign === "verified"
      ? "SHA-256 and Cosign verified"
      : result.cosign === "unavailable"
        ? "SHA-256 verified; Cosign unavailable"
        : "SHA-256 verified";
  const skill = result.skill === "installed" ? "; Cloud CLI skill updated" : "";
  console.log(`Updated cld to ${result.release.version} (${verification}${skill}${claude}).`);
  return 0;
};

const runProfileCommand = async (args: string[], locale: string): Promise<number> => {
  const [command, maybeName, ...rest] = args;
  if (!command || command === "help") {
    console.log(profileHelp(locale));
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
    console.log(
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
    console.log(
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
    console.log(text(locale, `Using profile "${maybeName}".`, `Profil "${maybeName}" wird verwendet.`));
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
          console.error(`Warning: could not read replaced OAuth refresh token for remote revocation: ${(error as Error).message}`);
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
      if (setsAuthProvider) delete next.oauth;
      if (token) next.token = token;
      if (tokenFile) next.tokenFile = tokenFile;
      if (tokenCommand) next.tokenCommand = tokenCommand;
      if (fd0) next.fd0 = { name: fd0, ...(fd0Scope ? { scope: fd0Scope } : {}) };

      latestConfig.profiles[name] = next;
      latestConfig.currentProfile ??= name;
      await saveConfig(latestConfig);

      if (setsAuthProvider && existing.oauth) {
        if (existing.server && displacedRefreshToken) {
          await revokeOAuthRefreshToken(existing.server, displacedRefreshToken).catch((error) => {
            console.error(`Warning: failed to revoke the replaced OAuth login: ${(error as Error).message}`);
          });
        }
        const displacedFd0 = existing.oauth.refreshTokenFd0;
        const reusesDisplacedFd0 = displacedFd0 && next.fd0?.name === displacedFd0.name && next.fd0.scope === displacedFd0.scope;
        if (displacedFd0 && !reusesDisplacedFd0) await removeFd0Secret(displacedFd0.name, displacedFd0.scope);
      }

      console.log(text(locale, `Saved profile "${name}" to ${CONFIG_PATH}.`, `Profil "${name}" wurde unter ${CONFIG_PATH} gespeichert.`));
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
    console.log(text(locale, `Open this URL in your browser:\n${url}`, `Öffne diese URL im Browser:\n${url}`));
  }
};

const promptToOpenBrowser = async (url: string, signal: AbortSignal, locale: string): Promise<void> => {
  if (!process.stdin.isTTY) {
    console.log(
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
      console.error(`Warning: could not open browser: ${(error as Error).message}`);
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
    console.log(text(locale, `Login URL:\n${url}`, `Anmelde-URL:\n${url}`));
    if (open) void promptToOpenBrowser(url, promptAbort.signal, locale);
    else
      console.log(
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

const runLoginCommand = async (args: string[], global: GlobalArgs): Promise<number> => {
  const [maybeName, ...rest] = args;
  const config = await loadConfig();
  const name = maybeName && !maybeName.startsWith("-") ? maybeName : (global.profile ?? config.currentProfile ?? DEFAULT_PROFILE);
  const flagArgs = maybeName && !maybeName.startsWith("-") ? rest : [maybeName, ...rest].filter((value): value is string => Boolean(value));
  const parsed = parseArgs(flagArgs, new Set([...BOOLEAN_FLAGS, "no-open"]));
  if ("client-id" in parsed.flags) {
    throw new CliError('cld login always uses the first-party "cloud-cli" OAuth client; --client-id is not supported.');
  }
  const existing = config.profiles?.[name] ?? {};
  const server = takeStringFlag(parsed.flags, "server") ?? global.server ?? process.env.CLD_SERVER ?? existing.server;
  if (!server) throw new CliError("Missing server. Run `cld login --server <url>`.");

  const scope = takeStringFlag(parsed.flags, "scope") ?? DEFAULT_OAUTH_SCOPE;
  const fd0Flag = parsed.flags.fd0;
  const fd0Name = typeof fd0Flag === "string" ? fd0Flag : fd0Flag === true ? `cloud-${name}-oauth-refresh-token` : undefined;
  const fd0Scope = takeStringFlag(parsed.flags, "fd0-scope") ?? global.fd0Scope;
  const normalizedServer = canonicalServer(server);
  const verifier = randomBase64Url(32);
  const state = randomBase64Url(24);

  const authorizationUrl = new URL(joinUrl(normalizedServer, "/oauth/authorize"));
  authorizationUrl.searchParams.set("client_id", OAUTH_CLIENT_ID);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", scope);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", await pkceChallenge(verifier));
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("redirect_uri", "http://127.0.0.1/callback");
  authorizationUrl.searchParams.set("ui_locales", global.locale);

  const code = await waitForOAuthCode(authorizationUrl, state, normalizedServer, !takeBooleanFlag(parsed.flags, "no-open"), global.locale);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: OAUTH_CLIENT_ID,
    code,
    redirect_uri: authorizationUrl.searchParams.get("redirect_uri") ?? "",
    code_verifier: verifier,
  });
  const token = await readOAuthTokenResponse(
    await fetchOAuth(joinUrl(normalizedServer, "/oauth/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
  );
  if (!token.refresh_token) throw new CliError("OAuth server did not issue a refresh token. Check the offline_access scope.");

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
        const oauth = await writeOAuthRefreshToken(baseSession, token.refresh_token!);
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
              console.error(`Warning: failed to restore the previous fd0 refresh token: ${(restoreError as Error).message}`);
            });
          } else {
            await removeFd0Secret(refreshTokenFd0.name, refreshTokenFd0.scope);
          }
        }
        throw error;
      }

      if (displacedRefreshToken && latestProfile.server && displacedSession) {
        await revokeOAuthRefreshToken(latestProfile.server, displacedRefreshToken).catch((error) => {
          console.error(`Warning: failed to revoke the previous OAuth login: ${(error as Error).message}`);
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
        console.error(`Warning: failed to revoke the unpersisted OAuth login: ${(revokeError as Error).message}`);
      });
    }
    throw error;
  }
  console.log(
    text(
      global.locale,
      `Logged in to ${normalizedServer} as profile "${name}".`,
      `Bei ${normalizedServer} als Profil "${name}" angemeldet.`,
    ),
  );
  return 0;
};

const runLogoutCommand = async (args: string[], global: GlobalArgs): Promise<number> => {
  const parsed = parseArgs(args);
  const config = await loadConfig();
  const name = takeStringFlag(parsed.flags, "profile", "p") ?? global.profile ?? resolveProfileName(config, undefined);
  return withConfigLock(async () => {
    const latestConfig = await loadConfig();
    const profile = latestConfig.profiles?.[name];
    if (!profile?.oauth) {
      console.log(
        text(global.locale, `Profile "${name}" is not logged in with OAuth.`, `Profil "${name}" ist nicht über OAuth angemeldet.`),
      );
      return 0;
    }

    let refreshToken: string | null = null;
    try {
      refreshToken = await readOAuthRefreshToken(profile.oauth);
    } catch (error) {
      console.error(`Warning: could not read refresh token for remote revocation: ${(error as Error).message}`);
    }

    if (profile.server && refreshToken) {
      await revokeOAuthRefreshToken(profile.server, refreshToken).catch((error) => {
        console.error(`Warning: ${(error as Error).message} Removing local credentials anyway.`);
      });
    }

    if (profile.oauth.refreshTokenFd0) {
      await removeFd0Secret(profile.oauth.refreshTokenFd0.name, profile.oauth.refreshTokenFd0.scope);
    }
    delete profile.oauth;
    await saveConfig(latestConfig);
    console.log(text(global.locale, `Logged out profile "${name}".`, `Profil "${name}" wurde abgemeldet.`));
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
    kind: profile?.oauth
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
  };

  if (global.output === "json" || takeBooleanFlag(parsed.flags, "json")) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`${text(global.locale, "Profile", "Profil")}: ${payload.profile}`);
    console.log(`Server: ${payload.server || "-"}`);
    console.log(`${text(global.locale, "Auth", "Authentifizierung")}: ${payload.kind}`);
    if (payload.accessTokenExpiresAt)
      console.log(`${text(global.locale, "Access token expires", "Access-Token läuft ab")}: ${payload.accessTokenExpiresAt}`);
    if (payload.refreshTokenStorage)
      console.log(`${text(global.locale, "Refresh token storage", "Speicherort des Refresh-Tokens")}: ${payload.refreshTokenStorage}`);
  }
  return 0;
};

export const main = async (argv = Bun.argv.slice(2)): Promise<number> => {
  if (argv.length === 1 && ["--version", "-V", "version"].includes(argv[0]!)) {
    console.log(`cld ${cliVersion} (${cliCommit})`);
    return 0;
  }
  const global = parseGlobalArgs(argv);
  const [moduleName, ...moduleArgs] = global.rest;

  if (!moduleName || moduleName === "help" || moduleName === "--help" || moduleName === "-h") {
    console.log(helpText(global.locale));
    return 0;
  }

  if (moduleName === "login") return runLoginCommand(moduleArgs, global);
  if (moduleName === "logout") return runLogoutCommand(moduleArgs, global);
  if (moduleName === "auth") return runAuthCommand(moduleArgs, global);
  if (moduleName === "profile") return runProfileCommand(moduleArgs, global.locale);
  if (moduleName === "update") return runUpdateCommand(moduleArgs, global.locale);

  const module = moduleByName.get(moduleName);
  if (!module)
    throw new CliError(
      `Unknown module "${moduleName}". Run \`cld help\`.`,
      1,
      `Unbekanntes Modul "${moduleName}". Führe \`cld help\` aus.`,
    );

  if (moduleArgs[0] === "help" || moduleArgs[0] === "--help" || moduleArgs[0] === "-h") {
    console.log(
      module.help?.() ??
        `${module.name}: ${global.locale.toLowerCase().startsWith("de") ? (germanModuleSummaries.get(module.name) ?? module.summary) : module.summary}`,
    );
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
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      const exitCode = error instanceof CliError ? error.exitCode : 1;
      if (wantsJsonError(Bun.argv.slice(2))) {
        const payload = errorPayload(error, exitCode);
        console.error(Bun.argv.includes("--jsonl") ? JSON.stringify(payload) : JSON.stringify(payload, null, 2));
      } else {
        let locale = "en";
        try {
          locale = parseGlobalArgs(Bun.argv.slice(2)).locale;
        } catch {
          locale = process.env.CLD_LOCALE ?? "en";
        }
        console.error(error instanceof CliError ? error.localizedMessage(locale) : error instanceof Error ? error.message : String(error));
      }
      process.exitCode = exitCode;
    },
  );
}
