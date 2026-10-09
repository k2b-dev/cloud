import { type AuthContext, auth, getEffectiveGroups } from "@k2b/cloud/server";
import { authFlows } from "@k2b/cloud/services";
import { type Context, Hono } from "hono";
import { proxyAuthService } from "./service";

const getUserBackedActor = (c: Context<AuthContext>) => {
  const actor = c.get("actor") as AuthContext["Variables"]["actor"] | undefined;
  if (!actor) return null;
  return actor.kind === "user" ? actor.user : actor.delegatedUser;
};

/**
 * The protected request's URL from Traefik's X-Forwarded-* headers, or the
 * fallback for direct and local calls and for a host value that is not a plain
 * host. A URI that resolves to another host, such as `//other.example/x`, or
 * does not parse returns to the protected host's root instead.
 */
export const forwardedRequestUrl = (headers: Headers, fallback: string): string => {
  const host = headers.get("X-Forwarded-Host");
  if (!host) return fallback;
  let origin: URL;
  try {
    origin = new URL(`${headers.get("X-Forwarded-Proto") ?? "https"}://${host}`);
  } catch {
    return fallback;
  }
  // Userinfo, a path, a query, or a fragment in the host or proto value would pick the origin.
  if (origin.href !== `${origin.origin}/`) return fallback;
  const uri = headers.get("X-Forwarded-Uri") ?? "/";
  try {
    const url = new URL(uri.startsWith("/") ? uri : `/${uri}`, origin);
    return url.origin === origin.origin ? url.href : origin.href;
  } catch {
    return origin.href;
  }
};

/**
 * Traefik ForwardAuth verify endpoint.
 *
 * Traefik sends a GET request with X-Forwarded-* headers.
 * - 200 + user headers = authenticated, request proceeds to upstream
 * - 302 = not authenticated, redirect to login
 * - 403 = authenticated but not authorized for this client
 */
const app = new Hono<AuthContext>().get("/verify/:clientId", auth.requireRole("*"), async (c) => {
  const actor = c.get("actor") as AuthContext["Variables"]["actor"] | undefined;
  const user = getUserBackedActor(c);
  const clientId = c.req.param("clientId");

  const originalUrl = forwardedRequestUrl(c.req.raw.headers, c.req.url);

  // Validate the forward-auth client before issuing any post-login return token.
  const client = await proxyAuthService.client.getByClientId({ clientId });
  if (!client) {
    return c.text("Unknown proxy auth client", 404);
  }

  // Not logged in → redirect to login with return URL
  if (!user) {
    if (actor) return c.text("Access denied: proxy auth requires a user-backed actor.", 403);
    const returnToken = await authFlows.proxyReturn.create({ clientId, url: originalUrl });
    if (!returnToken) {
      return c.text("Invalid proxy auth return URL", 400);
    }
    const returnPath = `/auth/proxy-return?token=${encodeURIComponent(returnToken)}`;
    const loginUrl = `/auth/login?redirectTo=${encodeURIComponent(returnPath)}`;
    return c.redirect(loginUrl, 302);
  }

  // Use the authoritative recursive membership graph for both the gate and
  // forwarded claims so nested memberships cannot disagree with each other.
  const effectiveGroups = await getEffectiveGroups({ userId: user.id });
  const effectiveGroupIds = new Set(effectiveGroups.map((group) => group.id));
  const hasAccess = client.allowedGroups.some((group) => effectiveGroupIds.has(group.id));

  if (!hasAccess) {
    return c.text("Access denied: you are not a member of an authorized group.", 403);
  }

  // Authenticated + authorized → 200 with user info headers
  c.header("X-Forwarded-User", user.uid);
  c.header("X-Forwarded-Email", user.mail ?? "");
  c.header("X-Forwarded-Groups", effectiveGroups.map((group) => group.name).join(","));
  return c.text("OK", 200);
});

export default app;
