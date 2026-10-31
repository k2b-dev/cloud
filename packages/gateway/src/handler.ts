import { APP_READINESS_PATH } from "@k2b/cloud";
import { DOMAIN_CHECK_PATH_PREFIX, domainCheckKey } from "@k2b/cloud/contracts/app-domains";
import { publishRequestTelemetry } from "@k2b/cloud/services";
import { redis } from "bun";
import { type DomainSnapshot, decideHost } from "./app-domains";
import type { ClientAddress } from "./client-address";
import { boundTemplateCardinality, derivePathTemplate } from "./path-template";
import { type ProxyStats, proxyRequest } from "./proxy";
import { checkPublicRate, publicResponseHeaders, rejectPublicOrigin, stripPublicHeaders } from "./public-protections";
import { isDomainCheckPath, isInternalPath } from "./request-boundary";
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
  readDomainCheckAnswer?: (key: string) => Promise<string | null>;
};

const unavailable = (): Response => new Response("Service unavailable", { status: 503, headers: { "Retry-After": "5" } });

/** One authority decision owns every path, including storage, probes and sockets. */
export const createGatewayHandler =
  (dependencies: GatewayDependencies) =>
  async (req: Request, server: GatewayServer, client: ClientAddress | null): Promise<Response | undefined> => {
    stripPublicHeaders(req.headers);
    const url = new URL(req.url);
    const snapshot = dependencies.snapshot();
    const decision = decideHost(req, snapshot);
    const websocket = req.headers.get("Upgrade")?.toLowerCase() === "websocket";
    const healthPath = url.pathname === "/health" || url.pathname === APP_READINESS_PATH;
    if (decision.kind === "unknown") {
      if (healthPath && !websocket) {
        return url.pathname === "/health" ? dependencies.health() : Response.json({ status: "ready", appId: "gateway" });
      }
      return snapshot.domainsReady ? new Response("Misdirected Request", { status: 421 }) : unavailable();
    }
    if (decision.kind === "assigned") {
      const { domain, target } = decision;
      const started = performance.now();
      const respond = (response: Response): Response => {
        publicResponseHeaders(response.headers);
        publishRequestTelemetry({
          appId: domain.appId,
          routePrefix: "/",
          pathTemplate: boundTemplateCardinality(domain.appId, derivePathTemplate(url.pathname)),
          method: req.method,
          status: response.status,
          durationMs: performance.now() - started,
          errorKind: null,
        });
        return response;
      };
      // Limits also cover aliases and checks; a valid nonce must not create an unbounded path.
      try {
        const limited = await (dependencies.rate ?? checkPublicRate)(domain.host, client?.address ?? "unknown");
        if (limited) return respond(limited);
        if (rejectPublicOrigin(req, decision)) return respond(new Response("Forbidden", { status: 403 }));
        if (req.method === "GET" && isDomainCheckPath(url.pathname)) {
          const nonce = url.pathname.slice(DOMAIN_CHECK_PATH_PREFIX.length);
          const answer = await (dependencies.readDomainCheckAnswer ?? ((key) => redis.get(key)))(domainCheckKey(domain.host, nonce));
          if (answer !== null) {
            return respond(new Response(answer, { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } }));
          }
        }
      } catch {
        // A limiter or nonce store outage cannot silently open the public boundary.
        dependencies.log("Public domain admission unavailable", { appId: domain.appId });
        return respond(unavailable());
      }
      if (isInternalPath(url.pathname, true) && !isDomainCheckPath(url.pathname))
        return respond(new Response("Not found", { status: 404 }));
      if (domain.redirectTo)
        return respond(
          new Response(null, {
            status: req.method === "GET" || req.method === "HEAD" ? 301 : 308,
            headers: { Location: `https://${domain.redirectTo}${url.pathname}${url.search}` },
          }),
        );
      if (decision.inactive) return respond(new Response("Misdirected Request", { status: 421 }));
      if (!target) return respond(unavailable());
      if (websocket) {
        const response = tryUpgradeWebSocket(req, server, dependencies.table(), dependencies.log, client, target);
        if (response) return respond(response);
        publishRequestTelemetry({
          appId: domain.appId,
          routePrefix: "/",
          pathTemplate: boundTemplateCardinality(domain.appId, derivePathTemplate(url.pathname)),
          method: req.method,
          status: 101,
          durationMs: performance.now() - started,
          errorKind: null,
        });
        return undefined;
      }
      return proxyRequest(req, dependencies.table(), dependencies.stats, dependencies.log, client, server.timeout.bind(server), target);
    }
    // The gateway owns its readiness probe; existing Cloud access routes still proxy.
    if (url.pathname === APP_READINESS_PATH && !websocket) return Response.json({ status: "ready", appId: "gateway" });
    if (isInternalPath(url.pathname)) return new Response("Not found", { status: 404 });
    if (/^https?:\/\/[^/]+\/public\/storage(?:\/|[?#]|$)/.test(req.url)) return dependencies.storage(req, client?.address ?? "unknown");
    if (websocket) {
      return tryUpgradeWebSocket(req, server, dependencies.table(), dependencies.log, client);
    }
    if (url.pathname === "/health") return dependencies.health();
    return proxyRequest(req, dependencies.table(), dependencies.stats, dependencies.log, client, server.timeout.bind(server));
  };
