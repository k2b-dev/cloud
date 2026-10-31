import type { AppRegistryEntry } from "@k2b/cloud/contracts";
import { type AppDomain, declaresPublicSurface, normalizeAppDomainHost } from "@k2b/cloud/contracts/app-domains";

export type PublicTarget = { appId: string; baseUrl: string; host: string; authority: string; scheme: "http" | "https" };
export type DomainSnapshot = {
  cloudHosts: ReadonlySet<string>;
  domains: ReadonlyMap<string, AppDomain>;
  domainsReady: boolean;
  apps: ReadonlyMap<string, AppRegistryEntry>;
  development: boolean;
};

/** Parse one authority, never a forwarded host, URL, userinfo or list. */
export const authorityHost = (authority: string | null): string | null => {
  if (!authority || /[\s/@?#\\,]/.test(authority)) return null;
  try {
    const url = new URL(`http://${authority}`);
    if (url.pathname !== "/" || url.username || url.password) return null;
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
};

export const cloudHostSet = (publicUrl: string, internalUrls: readonly string[], development: boolean): ReadonlySet<string> => {
  const hosts = new Set<string>();
  for (const value of [publicUrl, ...internalUrls]) {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    const host = authorityHost(url.host);
    if (!host) throw new Error("Invalid Cloud or internal gateway URL");
    hosts.add(host);
  }
  if (development) for (const host of ["localhost", "127.0.0.1", "[::1]"]) hosts.add(host);
  return hosts;
};

export type HostDecision =
  | { kind: "cloud" }
  | { kind: "unknown" }
  | { kind: "assigned"; domain: AppDomain; target: PublicTarget | null; inactive: boolean; authority: string; scheme: "http" | "https" };

export const decideHost = (req: Request, snapshot: DomainSnapshot): HostDecision => {
  const rawAuthority = req.headers.get("Host");
  const authority = authorityHost(rawAuthority);
  if (!authority) return { kind: "unknown" };
  if (snapshot.cloudHosts.has(authority)) return { kind: "cloud" };
  const host = normalizeAppDomainHost(authority);
  if (!host) return { kind: "unknown" };
  let domain = snapshot.domains.get(host);
  if (!domain && snapshot.development && host.endsWith(".localhost")) {
    const appId = host.slice(0, -".localhost".length);
    const app = snapshot.apps.get(appId);
    if (app && declaresPublicSurface(app)) domain = { host, appId, redirectTo: null, createdAt: "" };
  }
  if (!domain) return { kind: "unknown" };
  const app = snapshot.apps.get(domain.appId);
  const port = rawAuthority?.match(/:(\d+)$/)?.[1];
  const publicAuthority = host + (port ? `:${Number(port)}` : "");
  const scheme = snapshot.development && host.endsWith(".localhost") ? "http" : "https";
  return {
    kind: "assigned",
    authority: publicAuthority,
    scheme,
    domain,
    inactive: !!app && !declaresPublicSurface(app),
    target:
      app && declaresPublicSurface(app)
        ? {
            appId: app.id,
            baseUrl: app.baseUrl,
            host,
            authority: publicAuthority,
            scheme,
          }
        : null,
  };
};
