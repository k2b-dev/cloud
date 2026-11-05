import { type AuthContext, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import { ssr } from "../config";
import { chatPage, newChatPage, startPage } from "./page";

/** The Assistant part of the Cloud app below `/pwa/assistant`; only an app session reaches it. */
export const pwaRoutes = new Hono<AuthContext>()
  .get("/", auth.requireRole("user", ssr.pwaAccess), auth.requireUser(ssr.pwaAccess), ...startPage)
  .get("/new", auth.requireRole("user", ssr.pwaAccess), auth.requireUser(ssr.pwaAccess), ...newChatPage)
  .get("/c/:chat", auth.requireRole("user", ssr.pwaAccess), auth.requireUser(ssr.pwaAccess), ...chatPage);

export { pwaApi } from "./badge";
