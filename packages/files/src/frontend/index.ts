import { ssr } from "../config";
import { type AuthContext, auth } from "@k2b/cloud/server";
import { Hono } from "hono";
import filesDetailPage from "./[baseType]/[baseId]/page";
import filesAdminPage from "./admin";
import filesHomePage from "./home/page";
import filesPage from "./page";
import filesSearchPage from "./search/page";

export const adminPages = new Hono<AuthContext>().get("/", auth.requireRole("admin", ssr.access), ...filesAdminPage);

export default new Hono<AuthContext>()
  .get("/", auth.requireAccount({ provider: "ipa", profile: "user", onReject: ssr.access.onReject }), ...filesPage)
  .get("/search", auth.requireAccount({ provider: "ipa", profile: "user", onReject: ssr.access.onReject }), ...filesSearchPage)
  .get("/home", auth.requireAccount({ provider: "ipa", profile: "user", onReject: ssr.access.onReject }), ...filesHomePage)
  .get("/home/*", auth.requireAccount({ provider: "ipa", profile: "user", onReject: ssr.access.onReject }), ...filesHomePage)
  .get(
    "/:baseType/:baseId",
    auth.requireAccount({ provider: "ipa", profile: "user", onReject: ssr.access.onReject }),
    ...filesDetailPage,
  );
