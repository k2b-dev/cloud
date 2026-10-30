import { normalizeAppDomainHost } from "@k2b/cloud/contracts/app-domains";
import type { DomainSnapshot } from "./app-domains";

/** Only mounted on the private ingress listener, never on the public gateway. */
export const createIngressHandler =
  (snapshot: () => DomainSnapshot, gatewayUrl: string, certResolver: () => string) =>
  (req: Request): Response => {
    const url = new URL(req.url);
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
    const domains = snapshot().domains;
    if (url.pathname === "/_cloud/ingress/allowed") {
      const host = normalizeAppDomainHost(url.searchParams.get("domain") ?? "");
      return new Response(null, { status: host && domains.has(host) ? 200 : 404, headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname !== "/_cloud/ingress/traefik") return new Response("Not found", { status: 404 });
    const routers = Object.fromEntries(
      [...domains.keys()]
        .sort()
        .map((host) => [
          `app-domain-${host}`,
          { rule: `Host(\`${host}\`)`, entryPoints: ["websecure"], service: "cloud", tls: { certResolver: certResolver() } },
        ]),
    );
    return Response.json(
      {
        http: {
          routers,
          services: { cloud: { loadBalancer: { servers: [{ url: gatewayUrl }] } } },
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  };
