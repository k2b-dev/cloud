import { type AuthContext, auth, getLocale } from "@k2b/cloud/server";
import { AdminLayout } from "@k2b/cloud/ssr";
import { Hono } from "hono";
import { ssr } from "../../config";
import { storeAdmin } from "../../store/service";
import StoreAdmin from "./StoreAdmin.island";
import { storeMessages } from "./messages";

const page = ssr<AuthContext>(async (c) => {
  // Local settings only: a slow or unavailable store must never delay SSR.
  const initial = await storeAdmin.read({ actor: c.get("actor"), accessSubject: c.get("accessSubject") });
  const t = storeMessages.resolve([getLocale(c)]).t;
  return () => (
    <AdminLayout c={c} title={t.title}>
      <StoreAdmin initial={initial} />
    </AdminLayout>
  );
});
export default new Hono<AuthContext>()
  .use("*", auth.requireRole("admin", ssr.access))
  .use("*", auth.requireUser(ssr.access))
  .get("/", ...page);
