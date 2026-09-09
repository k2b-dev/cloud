import { ssr } from "../config";
import { type AuthContext, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import assistantPage from "./page";

export default new Hono<AuthContext>()
  .get("/", auth.requireRole("authenticated", ssr.access), auth.requireUser(ssr.access), ...assistantPage)
  .get("/chats", auth.requireRole("authenticated", ssr.access), auth.requireUser(ssr.access), (c) =>
    c.redirect("/app/assistant"),
  );
