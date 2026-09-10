import { Hono } from "hono";
import { auth, type AuthContext, expectUserBackedActor } from "@k2b/cloud/server";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { kitService } from "../service";
import AdminKit from "./Admin.island";
const page = ssr<AuthContext>(async (c) => {
  const search = (c.req.query("q") ?? "").slice(0, 120),
    page = Math.max(1, Math.min(100000, Math.floor(Number(c.req.query("page")) || 1)));
  const result = await kitService.adminList({ actor: c.get("actor"), accessSubject: c.get("accessSubject") }, page, search);
  return () => (
    <AdminLayout c={c} title="Kit">
      <AdminKit items={result.items} summary={result.summary} page={result.page} search={search} userId={expectUserBackedActor(c).id} />
    </AdminLayout>
  );
});
export default new Hono<AuthContext>().use("*", auth.requireRole("admin", ssr.access)).get("/", ...page);
