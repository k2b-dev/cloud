import { type AuthContext, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import { ssr } from "../config";
import adminPage from "./admin";
import page from "./page";

export default new Hono<AuthContext>().get("/", auth.requireRole("user", "guest", ssr.access), ...page);

export const adminPages = new Hono<AuthContext>().get("/", auth.requireRole("admin", ssr.access), ...adminPage);
