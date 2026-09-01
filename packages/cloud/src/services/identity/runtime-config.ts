import { get as getSetting } from "../settings";
import { publicCloudOrigin } from "../../shared/app-url";
import { CLOUD_IDENTITY_JWKS_PATH } from "./constants";

const RUNTIME_CONFIG_TTL_MS = 60_000;

export type IdentityRuntimeConfig = {
  issuer: string;
  jwksUrl: URL;
  groupsAdmin: string[];
};

let cached: { value: IdentityRuntimeConfig; expiresAt: number } | null = null;
let loading: Promise<IdentityRuntimeConfig> | null = null;

const normalizeGroups = (value: unknown): string[] => {
  if (!Array.isArray(value)) return ["admins"];
  const groups = [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
  return groups.length > 0 ? groups : ["admins"];
};

const resolveJwksUrl = (issuer: string): URL => {
  const developmentOrigin = process.env.NODE_ENV === "development" ? process.env.CLOUD_IDENTITY_DEV_JWKS_ORIGIN?.trim() : undefined;
  if (!developmentOrigin) return new URL(CLOUD_IDENTITY_JWKS_PATH, issuer);

  const url = new URL(CLOUD_IDENTITY_JWKS_PATH, developmentOrigin);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("CLOUD_IDENTITY_DEV_JWKS_ORIGIN must use http or https");
  }
  return url;
};

const load = async (): Promise<IdentityRuntimeConfig> => {
  const [appUrl, rawGroupsAdmin] = await Promise.all([
    getSetting<string>("app.url"),
    getSetting<unknown>("freeipa.groups.admin"),
  ]);
  const issuer = publicCloudOrigin(appUrl);
  if (process.env.NODE_ENV === "production" && new URL(issuer).protocol !== "https:") {
    throw new Error("Cloud identity issuer must use HTTPS in production");
  }
  return {
    issuer,
    jwksUrl: resolveJwksUrl(issuer),
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
