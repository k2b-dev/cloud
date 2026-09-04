import { ssr } from "../config";
import { type AuthContext, auth } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import contactUpsertPage from "./[bookId]/e/[contactId]/page";
import contactCreatePage from "./[bookId]/e/page";
import bookPage from "./[bookId]/page";
import adminPage from "./admin";
import page from "./page";

export default new Hono<AuthContext>()
  .get("/", auth.requireRole("user", ssr.access), ...page)
  .get("/:bookId/e/:contactId", auth.requireRole("user", ssr.access), ...contactUpsertPage)
  .get("/:bookId/e", auth.requireRole("user", ssr.access), ...contactCreatePage)
  .get("/:bookId", auth.requireRole("user", ssr.access), ...bookPage);

export const adminPages = new Hono<AuthContext>().get("/", auth.requireRole("admin", ssr.access), ...adminPage);
