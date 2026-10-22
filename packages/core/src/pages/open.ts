import { resolveCloudResourceHref, withCapabilityRequestTimeout } from "@k2b/cloud/api";
import { type AuthContext, auth, getLocale } from "@k2b/cloud/server";
import { Hono } from "hono";
import { ssr } from "../config";
import notFoundPage from "./NotFound";

export const createResourceOpenRoutes = (resolve = resolveCloudResourceHref) =>
  new Hono<AuthContext>().get(
    "/:type/:id",
    auth.requireRole("authenticated", ssr.access),
    auth.requireUser(ssr.access),
    async (c, next) => {
      const id = c.req.param("id");
      if (!id.startsWith("~")) return next();
      const href = await withCapabilityRequestTimeout(c, "query", () =>
        resolve({
          ref: { type: c.req.param("type"), id: id.slice(1) },
          request: c.req.raw,
          authority: auth.getAuthority(c),
          locale: getLocale(c),
        }),
      );
      return href ? c.redirect(href, 302) : next();
    },
    ...notFoundPage,
  );
