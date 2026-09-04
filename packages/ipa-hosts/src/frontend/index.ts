import { ssr } from "../config";
import { type AuthContext, auth } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import hostsPage from "./page";

export default new Hono<AuthContext>().get("/", auth.requireRole("admin", ssr.access), ...hostsPage);
