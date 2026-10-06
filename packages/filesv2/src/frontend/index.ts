import { type AuthContext, auth, rateLimit } from "@k2b/cloud/server";
import { AccountIdentityError } from "@k2b/cloud/services";
import { FilegateError } from "@k2b/filegate";
import { Hono } from "hono";
import { ssr } from "../config";
import { FilesError, filesService } from "../service";
import adminPage from "./admin";
import filesPage from "./page";
import { pdfPage } from "./pdf-page";
import { publicInboxPage, publicSharePage } from "./public-pages";
import { filesUrl } from "./urls";

export default new Hono<AuthContext>()
  .get("/app/filesv2", auth.requireRole("user", ssr.access), ...filesPage)
  .get("/app/filesv2/ref/:id", auth.requireRole("user", ssr.access), async (c) => {
    try {
      // A stable ref opens wherever the file is now; a path ref where it was named.
      const { base, entry } = await filesService.entryById(c.get("actor"), c.req.param("id"));
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
  .get("/share/filesv2/s/:token", auth.requireRole("*"), ...publicSharePage)
  .get("/share/filesv2/inbox/:token", auth.requireRole("*"), ...publicInboxPage)
  .get("/admin/filesv2", auth.requireRole("admin", ssr.access), ...adminPage)
  .get("/app/filesv2/*", auth.requireRole("user", ssr.access), (c) => ssr.error(c, 404))
  .get("/admin/filesv2/*", auth.requireRole("admin", ssr.access), (c) => ssr.error(c, 404));
