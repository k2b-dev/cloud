import { publicCloudOrigin } from "../../shared/app-url";
import { get as getSetting } from "../settings";
import { CLOUD_INVOCATION_JWKS_PATH, CLOUD_OAUTH_JWKS_PATH, CLOUD_SESSION_JWKS_PATH } from "./constants";

const RUNTIME_CONFIG_TTL_MS = 60_000;

export type IdentityRuntimeConfig = {
  issuer: string;
  sessionJwksUrl: URL;
  invocationJwksUrl: URL;
  oauthJwksUrl: URL;
  groupsAdmin: string[];
};

let cached: { value: IdentityRuntimeConfig; expiresAt: number } | null = null;
let loading: Promise<IdentityRuntimeConfig> | null = null;

const normalizeGroups = (value: unknown): string[] => {
  if (!Array.isArray(value)) return ["admins"];
  const groups = [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  return groups.length > 0 ? groups : ["admins"];
};

const resolveCoreJwksUrl = (issuer: string, path: string, transportOrigin = process.env.CLOUD_IDENTITY_JWKS_ORIGIN?.trim()): URL => {
  if (!transportOrigin) return new URL(path, issuer);
  const origin = new URL(transportOrigin);
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new Error("CLOUD_IDENTITY_JWKS_ORIGIN must use http or https");
  }
  return new URL(path, origin);
};

export const resolveSessionJwksUrl = (issuer: string, transportOrigin = process.env.CLOUD_IDENTITY_JWKS_ORIGIN?.trim()): URL =>
  resolveCoreJwksUrl(issuer, CLOUD_SESSION_JWKS_PATH, transportOrigin);

export const resolveInvocationJwksUrl = (issuer: string, transportOrigin = process.env.CLOUD_IDENTITY_JWKS_ORIGIN?.trim()): URL =>
  resolveCoreJwksUrl(issuer, CLOUD_INVOCATION_JWKS_PATH, transportOrigin);

export const resolveOAuthJwksUrl = (issuer: string, transportOrigin = process.env.CLOUD_OAUTH_JWKS_ORIGIN?.trim()): URL => {
  if (!transportOrigin) return new URL(CLOUD_OAUTH_JWKS_PATH, issuer);

  const url = new URL(CLOUD_OAUTH_JWKS_PATH, transportOrigin);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("CLOUD_OAUTH_JWKS_ORIGIN must use http or https");
  }
  return url;
};

const load = async (): Promise<IdentityRuntimeConfig> => {
  const [appUrl, rawGroupsAdmin] = await Promise.all([getSetting<string>("app.url"), getSetting<unknown>("freeipa.groups.admin")]);
  const issuer = publicCloudOrigin(appUrl);
  if (process.env.NODE_ENV === "production" && new URL(issuer).protocol !== "https:") {
    throw new Error("Cloud identity issuer must use HTTPS in production");
  }
  return {
    issuer,
    sessionJwksUrl: resolveSessionJwksUrl(issuer),
    invocationJwksUrl: resolveInvocationJwksUrl(issuer),
    oauthJwksUrl: resolveOAuthJwksUrl(issuer),
    groupsAdmin: normalizeGroups(rawGroupsAdmin),
  };
};

export const getIdentityRuntimeConfig = async (): Promise<IdentityRuntimeConfig> => {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  if (loading) return loading;
  loading = load()
    .then((value) => {
      cached = { value, expiresAt: Date.now() + RUNTIME_CONFIG_TTL_MS };
      return value;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
};

export const invalidateIdentityRuntimeConfig = (): void => {
  cached = null;
};
