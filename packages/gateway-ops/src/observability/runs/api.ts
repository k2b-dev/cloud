import { type AuthContext, auth, middleware, rateLimit, respond } from "@k2b/cloud/server";
import { err, fail, ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { syncOpsCredentials } from "../sync/service";
import { kindsOf, parseRunsAddress, RUNS_PER_PAGE, RUNS_PREVIEW, runsQuery } from "./query";
import { listRuns } from "./service";

/**
 * Mounted at `/api/gateway/runs`: the runs list for an address, as the page reads it. The query names the same
 * parameters as the page (`kind`, `status`, `app`, `time`, `q`, the per-kind filters, `page`); a part of it the
 * declaration does not allow is refused, not ignored.
 */
const app = new Hono<AuthContext>()
  .use("*", middleware.noTransform())
  .use(rateLimit())
  .use(auth.requireRole("admin"))
  .get("/", async (c) => {
    const params = new URL(c.req.url).searchParams;
    // The app named in the address stays a value of its filter, so any app id the person may see reads as itself.
    const address = parseRunsAddress(runsQuery("en", [], params.get("app") ?? undefined), params);
    const issues = address.issues.filter((issue) => !(issue.code === "unknown" && issue.param === "run"));
    if (issues.length > 0) {
      return respond(
        c,
        fail(err.badInput(`Invalid runs filter: ${issues.map((issue) => `${issue.param || "query"}=${issue.value}`).join(", ")}`)),
      );
    }
    const parts = await listRuns(address.state, kindsOf(address.state), {
      page: address.page,
      perPage: RUNS_PER_PAGE,
      preview: RUNS_PREVIEW,
      credentials: syncOpsCredentials(c.req.raw),
    });
    return respond(c, ok({ parts }));
  });

export default app;
export type RunsApi = typeof app;
