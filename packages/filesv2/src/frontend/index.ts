import { type AuthContext, auth } from "@k2b/cloud/server";
import { AccountIdentityError } from "@k2b/cloud/services";
import { FilegateError } from "@k2b/filegate";
import { Hono } from "hono";
import { ssr } from "../config";
import { resolveEntryRefId } from "../data/references";
import { FilesError, filesService } from "../service";
import adminPage from "./admin";
import filesPage from "./page";
import { publicInboxPage, publicSharePage } from "./public-pages";
import { filesUrl } from "./urls";

export default new Hono<AuthContext>()
  .get("/app/filesv2", auth.requireRole("user", ssr.access), ...filesPage)
  .get("/app/filesv2/ref/:id", auth.requireRole("user", ssr.access), async (c) => {
    const ref = await resolveEntryRefId(c.req.param("id"));
    if (!ref) return ssr.error(c, 404);
    try {
      const result = await filesService.entry(c.get("actor"), ref);
      const path = result.entry.directory ? ref.path : ref.path.split("/").slice(0, -1).join("/");
      return c.redirect(filesUrl(ref.baseId, path, undefined, result.entry.directory ? undefined : ref.path));
    } catch (error) {
      if (error instanceof FilesError || error instanceof AccountIdentityError) return ssr.error(c, error.status);
      if (error instanceof FilegateError) return ssr.error(c, error.status === 404 ? 404 : error.status === 403 ? 403 : 503);
      throw error;
    }
  })
  .get("/share/filesv2/s/:token", auth.requireRole("*"), ...publicSharePage)
  .get("/share/filesv2/inbox/:token", auth.requireRole("*"), ...publicInboxPage)
  .get("/admin/filesv2", auth.requireRole("admin", ssr.access), ...adminPage)
  .get("/app/filesv2/*", auth.requireRole("user", ssr.access), (c) => ssr.error(c, 404))
  .get("/admin/filesv2/*", auth.requireRole("admin", ssr.access), (c) => ssr.error(c, 404));
