import { type AuthContext, auth, middleware, rateLimit } from "@k2b/cloud/server";
import { AccountIdentityError } from "@k2b/cloud/services";
import { FilegateError } from "@k2b/filegate";
import { Hono } from "hono";
import { ssr } from "../config";
import { requestCall } from "../files-call";
import { FilesError, filesService } from "../service";
import adminPage from "./admin";
import executionPage from "./execution-page";
import filesPage from "./page";
import { pdfPage } from "./pdf-page";
import { publicInboxPage, publicSharePage } from "./public-pages";
import { filesUrl } from "./urls";

export default new Hono<AuthContext>()
  .use("/app/filesv2/*", (c, next) => {
    // Editor launches embed a private WOPI token or download lease beside the stored filename.
    if (c.req.query("view") === "edit" && c.req.query("file")) return middleware.noTransform()(c, next);
    return next();
  })
  .use("/admin/filesv2/*", (c, next) => {
    // Share owners cannot read other owners' private notes in the administrative share list.
    if (c.req.query("view") === "shares") return middleware.noTransform()(c, next);
    return next();
  })
  .get("/app/filesv2", auth.requireRole("user", ssr.access), ...filesPage)
  // Historical writers choose names and context strings beside another actor's authorized record.
  .get("/app/filesv2/execution/:activityId", auth.requireRole("user", ssr.access), middleware.noTransform(), ...executionPage)
  .get("/app/filesv2/ref/:id", auth.requireRole("user", ssr.access), async (c) => {
    try {
      // A stable ref opens wherever the file is now; a path ref where it was named.
      const { base, entry } = await filesService.entryById(requestCall(c), c.req.param("id"));
      const path = entry.directory ? entry.path : entry.path.split("/").slice(0, -1).join("/");
      return c.redirect(filesUrl(base.id, path, undefined, entry.directory ? undefined : entry.path));
    } catch (error) {
      if (error instanceof FilesError || error instanceof AccountIdentityError) return ssr.error(c, error.status);
      if (error instanceof FilegateError) return ssr.error(c, error.status === 404 ? 404 : error.status === 403 ? 403 : 503);
      throw error;
    }
  })
  // Each open streams a stored file, bounded like the Files API.
  .use("/app/filesv2/pdf/*", rateLimit())
  .route("/", pdfPage)
  // A share's public note sits next to file names that writers of the shared folder choose without holding the link.
  .use("/share/filesv2/*", middleware.noTransform())
  .get("/share/filesv2/s/:token", auth.requireRole("*"), ...publicSharePage)
  .get("/share/filesv2/inbox/:token", auth.requireRole("*"), ...publicInboxPage)
  .get("/admin/filesv2", auth.requireRole("admin", ssr.access), ...adminPage)
  .get("/app/filesv2/*", auth.requireRole("user", ssr.access), (c) => ssr.error(c, 404))
  .get("/admin/filesv2/*", auth.requireRole("admin", ssr.access), (c) => ssr.error(c, 404));
