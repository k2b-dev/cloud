import { type AuthContext, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import { ssr } from "../config";
import adminPage from "./admin";
import page from "./page";
import pwaPage from "./pwa.page";

const reader = auth.requireRole("user", "guest", ssr.access);
export default new Hono<AuthContext>()
  .get("/panel", reader, ...page)
  .get("/panel/c/:chat", reader, ...page)
  .get("/panel/c/:chat/m/:message", reader, ...page)
  .get("/panel/c/:chat/threads", reader, ...page)
  .get("/panel/c/:chat/t/:thread", reader, ...page)
  .get("/panel/c/:chat/t/:thread/m/:message", reader, ...page)
  .get("/", reader, ...page)
  .get("/c/:chat", reader, ...page)
  .get("/c/:chat/m/:message", reader, ...page)
  .get("/c/:chat/threads", reader, ...page)
  .get("/c/:chat/t/:thread", reader, ...page)
  .get("/c/:chat/t/:thread/m/:message", reader, ...page);

/** Chat in the Cloud app below `/pwa/chat`; only an app session reaches it. */
const appReader = [auth.requireRole("user", ssr.pwaAccess), auth.requireUser(ssr.pwaAccess)] as const;
export const pwaPages = new Hono<AuthContext>()
  .get("/", ...appReader, ...pwaPage)
  .get("/c/:chat", ...appReader, ...pwaPage)
  .get("/c/:chat/m/:message", ...appReader, ...pwaPage)
  .get("/c/:chat/threads", ...appReader, ...pwaPage)
  .get("/c/:chat/t/:thread", ...appReader, ...pwaPage)
  .get("/c/:chat/t/:thread/m/:message", ...appReader, ...pwaPage);

export const adminPages = new Hono<AuthContext>().get("/", auth.requireRole("admin", ssr.access), ...adminPage);
