import { AppPwaError } from "@k2b/cloud/app-pwa";
import { type AuthContext, auth, middleware } from "@k2b/cloud/server";
import { MinimalLayout } from "@k2b/cloud/ssr";
import { Hono } from "hono";
import CounterIsland from "./Counter.island";
import { ssr } from "./config";
import { COUNTER_PATH, STAFF_PATH } from "./constants";
import DevicesIsland from "./Devices.island";
import { PageSchema } from "./http";
import type { ExamplePwa } from "./platform";
import type { DevicePage } from "./Staff";

export function createExampleRouter(getPwa: () => ExamplePwa) {
  const router = new Hono<AuthContext>();
  // This boundary executes before any application signed-in middleware. Guest
  // requests cannot reach a handler that resolves or falls back to an employee.
  router.all(`${COUNTER_PATH}_api/*`, (c) => getPwa().router.fetch(c.req.raw));
  router.all("/api/visit-demo/app-pwa/*", (c) => getPwa().router.fetch(c.req.raw));
  router.use("*", middleware.runtime()).use("*", middleware.settings());
  router.get(COUNTER_PATH.slice(0, -1), (c) => c.redirect(COUNTER_PATH, 308));
  router.get(
    COUNTER_PATH,
    ...ssr<AuthContext>(async (c) => {
      c.get("page").title = "Laden-iPad";
      const publicOrigin = getPwa().service.publicOrigin;
      return () => (
        <MinimalLayout c={c}>
          <CounterIsland publicOrigin={publicOrigin} />
        </MinimalLayout>
      );
    }),
  );
  router.get(
    STAFF_PATH,
    auth.requireRole("authenticated", ssr.access),
    ...ssr<AuthContext>(async (c) => {
      const signIn = await auth.browserSignIn(c);
      if (!signIn) return ssr.error(c, 403, { layout: "minimal" });
      let initial: DevicePage = { items: [], next: null };
      let initialError = false;
      try {
        initial = PageSchema.parse(await getPwa().service.listDevices(signIn, undefined, c.req.raw.signal));
      } catch (error) {
        if (error instanceof AppPwaError && [401, 403, 404, 410].includes(error.status)) return ssr.error(c, 403, { layout: "minimal" });
        initialError = true;
      }
      c.get("page").title = "Laden-iPad koppeln";
      const publicOrigin = getPwa().service.publicOrigin;
      return () => (
        <MinimalLayout c={c}>
          <DevicesIsland publicOrigin={publicOrigin} initial={initial} initialError={initialError} />
        </MinimalLayout>
      );
    }),
  );
  router.get(`${COUNTER_PATH}*`, (c) => ssr.error(c, 404, { layout: "minimal" }));
  router.get("/app/visit-demo/*", auth.requireRole("authenticated", ssr.access), (c) => ssr.error(c, 404, { layout: "minimal" }));
  return router;
}
