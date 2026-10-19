import { type Context, Hono } from "hono";
import { CLOUD_INVOCATION_JWKS_PATH, CLOUD_SESSION_JWKS_PATH, IDENTITY_JWKS_MAX_AGE_SECONDS } from "./constants";
import { listIdentityJwks } from "./key-ring";

// If-None-Match uses weak comparison, including lists and the wildcard.
const matchesEtag = (header: string | undefined, etag: string): boolean =>
  header?.trim() === "*" || (header?.match(/(?:W\/)?"[^"]*"/g) ?? []).some((tag) => tag.replace(/^W\//, "") === etag.replace(/^W\//, ""));

const serveJwks = (purpose: "session" | "invocation") => async (c: Context) => {
  const jwks = await listIdentityJwks(purpose);
  if (matchesEtag(c.req.header("if-none-match"), jwks.etag)) {
    c.header("ETag", jwks.etag);
    c.header("Cache-Control", `public, max-age=${IDENTITY_JWKS_MAX_AGE_SECONDS}, must-revalidate`);
    return c.body(null, 304);
  }
  c.header("ETag", jwks.etag);
  c.header("Cache-Control", `public, max-age=${IDENTITY_JWKS_MAX_AGE_SECONDS}, must-revalidate`);
  return c.json({ keys: jwks.keys });
};

export const createIdentityPublicRoutes = (): Hono =>
  new Hono().get(CLOUD_SESSION_JWKS_PATH, serveJwks("session")).get(CLOUD_INVOCATION_JWKS_PATH, serveJwks("invocation"));
