import { APP_READINESS_PATH } from "@k2b/cloud";
import { DOMAIN_CHECK_PATH_PREFIX, domainCheckKey } from "@k2b/cloud/contracts/app-domains";
import { redis } from "bun";
import { type DomainSnapshot, decideHost } from "./app-domains";
import type { ClientAddress } from "./client-address";
import { type ProxyStats, proxyRequest } from "./proxy";
import { checkPublicRate, rejectPublicOrigin, stripPublicHeaders } from "./public-protections";
import { isInternalPath } from "./request-boundary";
import type { RouteTable } from "./trie";
import { tryUpgradeWebSocket } from "./ws-proxy";

type GatewayServer = {
  upgrade: (req: Request, options?: { data?: unknown; headers?: Record<string, string> }) => boolean;
  timeout: (req: Request, seconds: number) => void;
};

type GatewayDependencies = {
  snapshot: () => DomainSnapshot;
  table: () => RouteTable;
  stats: ProxyStats;
  log: (message: string, meta?: Record<string, unknown>) => void;
  health: () => Response;
  storage: (req: Request, address: string) => Promise<Response>;
  rate?: typeof checkPublicRate;
  hasNonce?: (key: string) => Promise<boolean>;
};

const unavailable = (): Response => new Response("Service unavailable", { status: 503, headers: { "Retry-After": "5" } });

/** One authority decision owns every path, including storage, probes and sockets. */
export const createGatewayHandler =
  (dependencies: GatewayDependencies) =>
  async (req: Request, server: GatewayServer, client: ClientAddress | null): Promise<Response | undefined> => {
    stripPublicHeaders(req.headers);
    const url = new URL(req.url);
    const decision = decideHost(req, dependencies.snapshot());
    const healthPath = url.pathname === "/health" || url.pathname === APP_READINESS_PATH;
    if (decision.kind === "unknown") {
      if (healthPath && req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return url.pathname === "/health" ? dependencies.health() : Response.json({ status: "ready", appId: "gateway" });
      }
      return new Response("Misdirected Request", { status: 421 });
    }
    if (decision.kind === "assigned") {
      const { domain, target } = decision;
      // Limits also cover aliases and checks; a valid nonce must not create an unbounded path.
      try {
        const limited = await (dependencies.rate ?? checkPublicRate)(domain.host, client?.address ?? "unknown");
        if (limited) return limited;
        if (req.method === "GET" && url.pathname.startsWith(DOMAIN_CHECK_PATH_PREFIX)) {
          const nonce = url.pathname.slice(DOMAIN_CHECK_PATH_PREFIX.length);
          if (
            nonce &&
            !nonce.includes("/") &&
            (await (dependencies.hasNonce ?? (async (key) => (await redis.get(key)) !== null))(domainCheckKey(domain.host, nonce)))
          ) {
            return new Response(nonce, { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
          }
        }
      } catch {
        // A limiter or nonce store outage cannot silently open the public boundary.
        dependencies.log("Public domain admission unavailable", { appId: domain.appId });
        return unavailable();
      }
      if (isInternalPath(url.pathname) && !url.pathname.startsWith(DOMAIN_CHECK_PATH_PREFIX))
        return new Response("Not found", { status: 404 });
      const publicOrigin = target ?? {
        appId: domain.appId,
        baseUrl: "",
        host: domain.host,
        authority: req.headers.get("Host") ?? domain.host,
        scheme: "https",
      };
      if (rejectPublicOrigin(req, publicOrigin)) return new Response("Forbidden", { status: 403 });
      if (domain.redirectTo)
        return new Response(null, {
          status: req.method === "GET" || req.method === "HEAD" ? 301 : 308,
          headers: { Location: `https://${domain.redirectTo}${url.pathname}${url.search}` },
        });
      if (decision.inactive) return new Response("Misdirected Request", { status: 421 });
      if (!target) return unavailable();
      if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        return tryUpgradeWebSocket(req, server, dependencies.table(), dependencies.log, client, target);
      }
      return proxyRequest(req, dependencies.table(), dependencies.stats, dependencies.log, client, server.timeout.bind(server), target);
    }
    // Readiness is the one public probe in the otherwise private /_cloud namespace.
    if (url.pathname === APP_READINESS_PATH) return Response.json({ status: "ready", appId: "gateway" });
    if (isInternalPath(url.pathname)) return new Response("Not found", { status: 404 });
    if (/^https?:\/\/[^/]+\/public\/storage(?:\/|[?#]|$)/.test(req.url)) return dependencies.storage(req, client?.address ?? "unknown");
    if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return tryUpgradeWebSocket(req, server, dependencies.table(), dependencies.log, client);
    }
    if (url.pathname === "/health") return dependencies.health();
    return proxyRequest(req, dependencies.table(), dependencies.stats, dependencies.log, client, server.timeout.bind(server));
  };
