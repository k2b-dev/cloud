import { type AuthContext, auth, getLocale } from "@k2b/cloud/server";
import { AdminLayout } from "@k2b/cloud/ssr";
import { Hono } from "hono";
import { z } from "zod";
import { ssr } from "../config";
import Admin from "./Admin.island";
import { artifactAdmin } from "./admin";
import { artifactMessages } from "./messages";

const page = ssr<AuthContext>(async (c) => {
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(100000)
    .catch(1)
    .parse(c.req.query("page") ?? 1);
  const search = (c.req.query("search") ?? "").slice(0, 120);
  const initial = await artifactAdmin.list({ actor: c.get("actor"), accessSubject: c.get("accessSubject") }, page, search);
  const t = artifactMessages.resolve([getLocale(c)]).t;
  return () => (
    <AdminLayout c={c} title={t.administration}>
      <Admin initial={initial} search={search} />
    </AdminLayout>
  );
});
export default new Hono<AuthContext>()
  .use("*", auth.requireRole("admin", ssr.access))
  .use("*", auth.requireUser(ssr.access))
  .get("/", ...page);
