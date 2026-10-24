import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { appAccessManagementPath } from "../_internal/app-access-path";
import { getApp } from "../_internal/registry";
import type { AppMeta } from "../contracts/app";
import type { AppAccessDeclaration } from "../contracts/app-access";
import { PrincipalSchema } from "../contracts/shared";
import { type AuthContext, auth } from "../server/middleware/auth";
import { v } from "../server/middleware/validator";
import { AppAccessManagementError, changeAppAccess, readAppAccess } from "../services/app-access-management";

// One UUID principal, level and action; the 4 KiB envelope also bounds malformed JSON.
export const APP_ACCESS_CHANGE_MAX_BYTES = 4096;
const repairQuery = v("query", z.object({ repair: z.literal("1").optional() }));
const permission = z.enum(["read", "admin"]);
export const AppAccessChangeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("grant"), principal: PrincipalSchema, permission }).strict(),
  z
    .object({ action: z.literal("update"), accessId: z.union([z.string().uuid(), z.literal("inherited-authenticated")]), permission })
    .strict(),
  z.object({ action: z.literal("revoke"), accessId: z.union([z.string().uuid(), z.literal("inherited-authenticated")]) }).strict(),
]);
const base = () =>
  new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.header("Cache-Control", "private, no-store");
      await next();
    })
    .use("*", auth.requireRole("authenticated"))
    .onError((error, c) => {
      if (error instanceof AppAccessManagementError) return c.json({ code: error.code, message: error.message }, error.status);
      if (error instanceof HTTPException) return error.getResponse();
      throw error;
    });

/** Mounted by the framework before the app-use gate; management still requires its own current grant. */
export const createOwnedAppAccessRoutes = (app: AppMeta, canManage?: AppAccessDeclaration["canManage"]) =>
  base()
    .get("/", async (c) => c.json(await readAppAccess({ app, authority: auth.getAuthority(c), canManage })))
    .post("/", bodyLimit({ maxSize: APP_ACCESS_CHANGE_MAX_BYTES }), v("json", AppAccessChangeSchema), async (c) =>
      c.json(
        await changeAppAccess({
          app,
          authority: auth.getAuthority(c),
          canManage,
          change: c.req.valid("json"),
          requestId: c.req.header("x-request-id"),
        }),
      ),
    );

/** Stable Core URL. Managers continue at the owning app; administrators explicitly choose repair. */
export const createAppAccessRoutes = () =>
  base()
    .get("/:appId", repairQuery, async (c) => {
      const appId = c.req.param("appId");
      if (!appId) return c.json({ message: "App not found" }, 404);
      const app = await getApp(appId);
      if (!app) return c.json({ message: "App not found" }, 404);
      if (app.access?.kind !== "grants")
        throw new AppAccessManagementError("APP_ACCESS_FIXED", "This application uses a fixed access rule.", 409);
      if (c.req.query("repair") !== "1") return c.redirect(appAccessManagementPath(app), 307);
      return c.json(await readAppAccess({ app, authority: auth.getAuthority(c), repair: true }));
    })
    .post("/:appId", repairQuery, bodyLimit({ maxSize: APP_ACCESS_CHANGE_MAX_BYTES }), v("json", AppAccessChangeSchema), async (c) => {
      const appId = c.req.param("appId");
      if (!appId) return c.json({ message: "App not found" }, 404);
      const app = await getApp(appId);
      if (!app) return c.json({ message: "App not found" }, 404);
      if (app.access?.kind !== "grants")
        throw new AppAccessManagementError("APP_ACCESS_FIXED", "This application uses a fixed access rule.", 409);
      if (c.req.query("repair") !== "1") return c.redirect(appAccessManagementPath(app), 307);
      return c.json(
        await changeAppAccess({
          app,
          authority: auth.getAuthority(c),
          repair: true,
          change: c.req.valid("json"),
          requestId: c.req.header("x-request-id"),
        }),
      );
    });
export type AppAccessApi = ReturnType<typeof createAppAccessRoutes>;
