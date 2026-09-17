import {
  type AuthContext,
  auth,
  getLocale,
  jsonResponse,
  middleware,
  rateLimit,
  requiresAdmin,
  requiresAuth,
  respond,
  v,
} from "@k2b/cloud/server";
import { AccountIdentityError } from "@k2b/cloud/services";
import { FilegateError } from "@k2b/filegate";
import { ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { z } from "zod";
import {
  AdminQuerySchema,
  AdoptInputSchema,
  BrowseQuerySchema,
  ConfigurationInputSchema,
  DownloadInputSchema,
  ErrorSchema,
} from "../contracts";
import { FilesError, filesService } from "../service";
import { errorMessage } from "./messages";

const api = new Hono<AuthContext>()
  .use(rateLimit())
  .use("*", auth.requireRole("user"))
  .onError((error, c) => {
    const known = error instanceof FilesError || error instanceof AccountIdentityError;
    const code = known ? error.code : error instanceof FilegateError && error.status === 404 ? "not_found" : "unavailable";
    const status = known ? error.status : code === "not_found" ? 404 : 503;
    return respond(c, { ok: false, error: errorMessage(code, getLocale(c)), status, code });
  })
  .get("/bases", middleware.openapi({ summary: "List accessible file bases", ...requiresAuth }), async (c) =>
    respond(c, ok(await filesService.bases(c.get("actor")))),
  )
  .get(
    "/bases/:baseId/entries",
    middleware.openapi({ summary: "List current filesystem entries", ...requiresAuth }),
    v("query", BrowseQuerySchema),
    async (c) => respond(c, ok(await filesService.list(c.get("actor"), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("query") }))),
  )
  .post(
    "/bases/:baseId/download",
    middleware.openapi({
      summary: "Issue a single-file download lease",
      ...requiresAuth,
      responses: {
        200: jsonResponse(z.object({ url: z.string(), method: z.literal("GET"), expires: z.string() }), "Download lease"),
        403: jsonResponse(ErrorSchema, "Denied"),
      },
    }),
    v("json", DownloadInputSchema),
    async (c) =>
      respond(c, ok(await filesService.download(c.get("actor"), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("json") }))),
  )
  .use("/admin/*", auth.requireRole("admin"))
  .get(
    "/admin",
    auth.requireRole("admin"),
    middleware.openapi({ summary: "Read configuration and filesystem inventory", ...requiresAdmin }),
    v("query", AdminQuerySchema),
    async (c) => respond(c, ok(await filesService.admin(c.get("actor"), c.req.valid("query")))),
  )
  .put(
    "/admin/configuration",
    middleware.openapi({ summary: "Save Files v2 configuration", ...requiresAdmin }),
    v("json", ConfigurationInputSchema),
    async (c) => {
      await filesService.saveConfiguration(c.get("actor"), c.req.valid("json"));
      return respond(c, ok({ saved: true }));
    },
  )
  .post(
    "/admin/adopt",
    middleware.openapi({ summary: "Bind an existing directory to its current identity", ...requiresAdmin }),
    v("json", AdoptInputSchema),
    async (c) => respond(c, ok(await filesService.adopt(c.get("actor"), c.req.valid("json")))),
  );
export default api;
export type ApiType = typeof api;
