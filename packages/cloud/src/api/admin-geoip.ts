import { Hono, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { GEOIP_MAX_DATABASE_BYTES, GEOIP_MAX_REQUEST_BYTES } from "../contracts/geoip";
import { type AuthContext, auth, v } from "../server";
import { REQUEST_IDLE_TIMEOUT_MAX_SECONDS, REQUEST_IDLE_TIMEOUT_SECONDS, setRequestTimeout } from "../server/request-timeout";
import { GeoIpError, geoip } from "../services/geoip";

export const createAdminGeoIpRoutes = (
  authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("admin"),
  service: typeof geoip = geoip,
) =>
  new Hono<AuthContext>()
    .use(authenticate)
    .onError((error, c) => {
      if (error instanceof GeoIpError)
        return c.json(
          {
            code: error.code,
            ...(error.code === "geoip_too_large" ? { maxDatabaseBytes: GEOIP_MAX_DATABASE_BYTES } : {}),
            ...(error.code === "geoip_request_too_large" ? { maxRequestBytes: GEOIP_MAX_REQUEST_BYTES } : {}),
          },
          error.status,
        );
      if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
      throw error;
    })
    .get(
      "/",
      describeRoute({ tags: ["Sign-in locations"], summary: "Show active sign-in location databases and upload limits" }),
      auth.requireOAuthScope("read", "admin"),
      async (c) => c.json(await service.status(c.get("user"))),
    )
    .put(
      "/",
      describeRoute({
        tags: ["Sign-in locations"],
        summary: "Replace a City or ASN database with a raw or gzip MMDB upload",
        requestBody: {
          required: true,
          content: {
            "application/octet-stream": { schema: { type: "string", format: "binary" } },
            "application/gzip": { schema: { type: "string", format: "binary" } },
          },
        },
      }),
      auth.requireOAuthScope("write", "admin"),
      async (c) => {
        setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_MAX_SECONDS);
        try {
          const length = c.req.header("Content-Length");
          return c.json(
            await service.upload(
              c.get("user"),
              c.req.raw.body ??
                new ReadableStream({
                  start(controller) {
                    controller.close();
                  },
                }),
              {
                contentLength: length === undefined ? undefined : Number(length),
                signal: c.req.raw.signal,
              },
            ),
          );
        } finally {
          setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
        }
      },
    )
    .delete(
      "/:kind",
      describeRoute({ tags: ["Sign-in locations"], summary: "Reset one sign-in database to the bundled snapshot" }),
      auth.requireOAuthScope("write", "admin"),
      v("param", z.object({ kind: z.enum(["city", "asn"]) })),
      async (c) => c.json(await service.reset(c.get("user"), c.req.valid("param").kind)),
    );

export default createAdminGeoIpRoutes();
