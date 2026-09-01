import { Hono } from "hono";
import { IDENTITY_JWKS_MAX_AGE_SECONDS } from "./constants";
import { listIdentityJwks } from "./key-ring";

export const createIdentityPublicRoutes = (): Hono =>
  new Hono().get("/.well-known/cloud-identity-jwks.json", async (c) => {
    const jwks = await listIdentityJwks();
    if (c.req.header("if-none-match") === jwks.etag) {
      c.header("ETag", jwks.etag);
      c.header("Cache-Control", `public, max-age=${IDENTITY_JWKS_MAX_AGE_SECONDS}, must-revalidate`);
      return c.body(null, 304);
    }
    c.header("ETag", jwks.etag);
    c.header("Cache-Control", `public, max-age=${IDENTITY_JWKS_MAX_AGE_SECONDS}, must-revalidate`);
    return c.json({ keys: jwks.keys });
  });
