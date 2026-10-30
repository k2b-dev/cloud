import { isCloudCredentialCookie } from "@k2b/cloud/contracts/app-domains";
import { ratelimit } from "@k2b/cloud/server/ratelimit.ts";
import { get } from "@k2b/cloud/services/settings";
import type { PublicTarget } from "./app-domains";

export const stripPublicHeaders = (headers: Headers): void => {
  for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith("x-cloud-public-")) headers.delete(name);
};

export const stripCloudCookies = (headers: Headers): void => {
  const cookie = headers.get("Cookie");
  if (cookie === null) return;
  const kept = cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const equals = part.indexOf("=");
      return equals > 0 && !isCloudCredentialCookie(part.slice(0, equals).trim());
    });
  if (kept.length) headers.set("Cookie", kept.join("; "));
  else headers.delete("Cookie");
};

export const rejectPublicOrigin = (req: Request, target: PublicTarget): boolean => {
  if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket" && ["GET", "HEAD", "OPTIONS"].includes(req.method)) return false;
  const origin = req.headers.get("Origin");
  const site = req.headers.get("Sec-Fetch-Site");
  return (
    (origin !== null && origin !== new URL(`${target.scheme}://${target.authority}`).origin) ||
    site === "cross-site" ||
    site === "same-site"
  );
};

// A domain can serve 100 clients at their full individual budget concurrently.
// This bounds aggregate work per tenant while leaving ordinary page fan-out headroom.
export const PUBLIC_HOST_BUDGET_FACTOR = 100;
let cached: { budget: number; client: ReturnType<typeof ratelimit>; host: ReturnType<typeof ratelimit> } | undefined;
export const checkPublicRate = async (host: string, address: string): Promise<Response | null> => {
  const budget = await get<number>("security.rate_limit_per_second");
  if (!cached || cached.budget !== budget)
    cached = {
      budget,
      client: ratelimit({ id: "client", prefix: "cloud:public-domains", limit: budget }),
      host: ratelimit({ id: "host", prefix: "cloud:public-domains", limit: budget * PUBLIC_HOST_BUDGET_FACTOR }),
    };
  const hostResult = await cached.host.check(host);
  const result = hostResult.limited ? hostResult : await cached.client.check(`${host}:${address}`);
  return result.limited
    ? new Response("Too many requests", {
        status: 429,
        headers: { "Retry-After": String(Math.max(1, Math.ceil(result.resetIn / 1000))) },
      })
    : null;
};

export const publicResponseHeaders = (headers: Headers): void => {
  for (const name of [...headers.keys()]) {
    if (/^x-(?:gateway-|cloud-)/i.test(name)) headers.delete(name);
  }
  if (headers.has("Set-Cookie")) headers.set("Cache-Control", "private, no-store");
  if (!headers.has("X-Content-Type-Options")) headers.set("X-Content-Type-Options", "nosniff");
  if (!headers.has("Referrer-Policy")) headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
};
