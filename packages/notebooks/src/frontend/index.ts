import { ssr } from "../config";
import { type AuthContext, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import notebookAttachmentsPage from "./[id]/attachments/page";
import notebookDetailPage from "./[id]/page";
import notebookTagPage from "./[id]/tags/[tag]/page";
import notebooksAdminPage from "./admin";
import notebooksPage from "./page";

export const adminPages = new Hono<AuthContext>().get("/", auth.requireRole("admin", ssr.access), ...notebooksAdminPage);

export default new Hono<AuthContext>()
  .get("/", auth.requireRole("authenticated", ssr.access), auth.requireUser(ssr.access), ...notebooksPage)
  // Both `/notebooks/:id` and `/notebooks/:id/notes/:noteId` hit the same
  // SSR handler — the latter just supplies a `noteId` route param. The
  // handler reads both shape variants from `c.req.param(...)`.
  .get("/:id", auth.requireRole("authenticated", ssr.access), auth.requireUser(ssr.access), ...notebookDetailPage)
  .get("/:id/notes/:noteId", auth.requireRole("authenticated", ssr.access), auth.requireUser(ssr.access), ...notebookDetailPage)
  .get("/:id/attachments", auth.requireRole("authenticated", ssr.access), auth.requireUser(ssr.access), ...notebookAttachmentsPage)
  .get("/:id/tags/:tag", auth.requireRole("authenticated", ssr.access), auth.requireUser(ssr.access), ...notebookTagPage);
