import { ssr } from "../config";
import { type AuthContext, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import proxyAuthPage from "./page";

export default new Hono<AuthContext>().get("/", auth.requireRole("admin", ssr.access), ...proxyAuthPage);
