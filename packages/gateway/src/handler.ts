import { APP_READINESS_PATH, redis } from "@k2b/cloud";
import { DOMAIN_CHECK_PATH_PREFIX, domainCheckKey } from "@k2b/cloud/contracts/app-domains";
import { GATEWAY_STATUS_PATH, MAINTENANCE_ADMIN_API_PATH, MAINTENANCE_BYPASS_HEADER } from "@k2b/cloud/contracts/maintenance";
import { publishRequestTelemetry } from "@k2b/cloud/services";
import { type DomainSnapshot, decideHost } from "./app-domains";
import type { Availability } from "./availability";
import type { ClientAddress } from "./client-address";
import { defaultFraming } from "./framing";
import { bypassesMaintenance, bypassLinkAnswer, splitBypassParam, takeBypassCookie } from "./maintenance-bypass";
import { boundTemplateCardinality, derivePathTemplate } from "./path-template";
import { type ProxyAvailability, type ProxyStats, proxyRequest } from "./proxy";
import { checkPublicRate, publicResponseHeaders, rejectPublicOrigin, stripPublicHeaders } from "./public-protections";
import { isDomainCheckPath, isInternalPath } from "./request-boundary";
import { matchRoute, type RouteTable } from "./trie";
import { appUnavailableAnswer, maintenanceAnswer, statusAnswer } from "./unavailable-answer";
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
  /** Maintenance state and app presentation held in memory; without it the gateway answers as before. */
  availability?: Availability;
  /** Clock for admin bypass expiry. */
  now?: () => number;
};

const unavailable = (): Response => new Response("Service unavailable", { status: 503, headers: { "Retry-After": "5" } });

const isStatusRequest = (req: Request, url: URL): boolean =>
  (req.method === "GET" || req.method === "HEAD") && url.pathname === GATEWAY_STATUS_PATH;

/**
 * During whole-Cloud maintenance only Core's maintenance admin API (Core authenticates and authorizes it) and the
 * OAuth token endpoint, so `cld` can renew an expired access token for it, still reach an upstream.
 */
const passesMaintenance = (req: Request, url: URL, table: RouteTable): boolean => {
  if (url.pathname === "/oauth/token") return req.method === "POST";
  if (url.pathname !== MAINTENANCE_ADMIN_API_PATH && !url.pathname.startsWith(`${MAINTENANCE_ADMIN_API_PATH}/`)) return false;
  return matchRoute(table, url.pathname)?.appId === "core";
};

/**
 * A request with the admin bypass parameter never reaches an app: `GET`/`HEAD` get the gateway's redirect without
 * it (with the cookie only for a valid link on the Cloud host), every other method a `400`. Setting the cookie
 * logs one line, so every redemption is visible; the token itself is never logged.
 */
const bypassLink = (
  req: Request,
  url: URL,
  availability: Availability | undefined,
  {
    log,
    client,
    ...options
  }: { development: boolean; allowCookie: boolean; now: number; log: GatewayDependencies["log"]; client: ClientAddress | null },
): Response => {
  if (req.method !== "GET" && req.method !== "HEAD")
    return new Response("Bad Request", { status: 400, headers: { "Cache-Control": "no-store" } });
  const { response, bypass } = bypassLinkAnswer(url, splitBypassParam(url.search).token, availability?.maintenance() ?? null, options);
  if (bypass)
    log("Maintenance bypass cookie set", {
      subject: bypass.subject,
      client: client?.address ?? "unknown",
      expiresAt: new Date(bypass.expiresAt).toISOString(),
    });
  return response;
};

/**
 * One authority decision owns every path, including storage, probes and sockets. Every answer, proxied or the
 * gateway's own, leaves here, so this is where an HTML answer without a framing policy of its own gets the default.
 */
export const createGatewayHandler = (dependencies: GatewayDependencies) => {
  const handle = decide(dependencies);
  return async (req: Request, server: GatewayServer, client: ClientAddress | null): Promise<Response | undefined> => {
    const response = await handle(req, server, client);
    if (response) defaultFraming(response.headers);
    return response;
  };
};

const decide =
  (dependencies: GatewayDependencies) =>
  async (req: Request, server: GatewayServer, client: ClientAddress | null): Promise<Response | undefined> => {
    stripPublicHeaders(req.headers);
    // Only the gateway says that a request passed the maintenance wall.
    req.headers.delete(MAINTENANCE_BYPASS_HEADER);
    const now = dependencies.now ?? Date.now;
    const url = new URL(req.url);
    const snapshot = dependencies.snapshot();
    // The admin bypass cookie is gateway business on every host: read it, then no upstream ever sees it.
    const bypassCookies = takeBypassCookie(req.headers, snapshot.development);
    const bypassParam = url.search.length > 1 && splitBypassParam(url.search).present;
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
      const availability = dependencies.availability;
      // App domains never bypass maintenance; the link only loses its parameter here.
      if (bypassParam)
        return respond(
          bypassLink(req, url, availability, {
            development: snapshot.development,
            allowCookie: false,
            now: now(),
            log: dependencies.log,
            client,
          }),
        );
      if (availability && isStatusRequest(req, url)) return respond(statusAnswer(req, url, availability));
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
      if (availability?.maintenance()) return respond(maintenanceAnswer(req, availability));
      if (!target)
        return respond(availability ? appUnavailableAnswer(req, availability, domain.appId, { cloudHost: false }) : unavailable());
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
      const publicAvailability: ProxyAvailability | undefined = availability && {
        vanishedOwner: () => null,
        upstreamFailed: availability.upstreamFailed,
        upstreamAnswered: availability.upstreamAnswered,
        answer: (req, appId, reason) => {
          const response = appUnavailableAnswer(req, availability, appId, { reason, cloudHost: false });
          publicResponseHeaders(response.headers);
          return response;
        },
      };
      return proxyRequest(
        req,
        dependencies.table(),
        dependencies.stats,
        dependencies.log,
        client,
        server.timeout.bind(server),
        target,
        publicAvailability,
      );
    }
    // The gateway owns its readiness probe; existing Cloud access routes still proxy.
    if (url.pathname === APP_READINESS_PATH && !websocket) return Response.json({ status: "ready", appId: "gateway" });
    const availability = dependencies.availability;
    if (bypassParam)
      return bypassLink(req, url, availability, {
        development: snapshot.development,
        allowCookie: true,
        now: now(),
        log: dependencies.log,
        client,
      });
    const maintenance = availability?.maintenance() ?? null;
    // A valid admin bypass cookie passes the maintenance wall exactly as if there were no maintenance.
    const bypassed = maintenance !== null && bypassesMaintenance(bypassCookies, maintenance, now());
    // Pages rendered for it say that only this person sees the Cloud.
    if (bypassed) req.headers.set(MAINTENANCE_BYPASS_HEADER, "1");
    if (availability && isStatusRequest(req, url)) return statusAnswer(req, url, availability, { bypass: bypassed });
    if (isInternalPath(url.pathname)) return new Response("Not found", { status: 404 });
    if (availability && maintenance && !bypassed) {
      if (url.pathname === "/health" && !websocket) return dependencies.health();
      if (websocket || !passesMaintenance(req, url, dependencies.table())) return maintenanceAnswer(req, availability);
    }
    const cloudAvailability: ProxyAvailability | undefined = availability && {
      vanishedOwner: availability.vanishedOwner,
      upstreamFailed: availability.upstreamFailed,
      upstreamAnswered: availability.upstreamAnswered,
      answer: (req, appId, reason) => appUnavailableAnswer(req, availability, appId, { reason, cloudHost: true }),
    };
    if (/^https?:\/\/[^/]+\/public\/storage(?:\/|[?#]|$)/.test(req.url)) return dependencies.storage(req, client?.address ?? "unknown");
    if (websocket) {
      return tryUpgradeWebSocket(req, server, dependencies.table(), dependencies.log, client, undefined, cloudAvailability);
    }
    if (url.pathname === "/health") return dependencies.health();
    return proxyRequest(
      req,
      dependencies.table(),
      dependencies.stats,
      dependencies.log,
      client,
      server.timeout.bind(server),
      undefined,
      cloudAvailability,
    );
  };
