import { CODE_REQUEST_LIMITS, codeOwnPath, matchCodeRoute } from "@k2b/cloud/code";
import { type CodeCheckedVersionManifest, isSafeNotificationTargetHref } from "@k2b/cloud/contracts";
import { type AuthContext, auth, getLocale, middleware, ratelimit, v } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { isCodePageMember } from "../code/access";
import { admitCodePage } from "../code/page-admission";
import { CodePageChangedError, readCodePageProvenance } from "../code/page-provenance";
import { codePageProvenanceRoutes } from "../code/page-provenance-contracts";
import { CODE_PAGE_REPORTS_PER_HOUR, fileCodePageReport } from "../code/page-reports";
import { waitCodeRequest } from "../code/request-deadline";
import { CodeRequestError, codeRequestVersion } from "../code/requests";
import { checkCodePageVersionValue } from "../code/route-security";

/**
 * The route the card asks about: the page a browser opened with GET, or, for the answer to a form sent without
 * scripts, the first route whose own method serves this path. Either way admission applies that route's rules.
 */
const selectLabelRoute = (manifest: CodeCheckedVersionManifest, path: string) => {
  const routes = manifest.entrypoints.filter((entry) => entry.kind === "route" && entry.route);
  return (
    routes.find((entry) => entry.route && matchCodeRoute(entry.route, "GET", path)) ??
    routes.find((entry) => entry.route && matchCodeRoute(entry.route, entry.route.method === "ALL" ? "GET" : entry.route.method, path))
  );
};

/** A page path inside one Code as hosting serves it: canonical, without query or fragment. */
const isPagePath = (codeId: string, path: string) => {
  try {
    const own = codeOwnPath(codeId, path);
    return !/[?#]/.test(path) && isSafeNotificationTargetHref(own) && new URL(own, "https://cloud.invalid").pathname === own;
  } catch {
    return false;
  }
};

const badInput = () => ({ code: "BAD_INPUT", message: "Invalid page request." });

/**
 * Browser routes of a Code page's label (`codePageProvenanceRoutes`): the card's facts and a member's report. Both
 * admit exactly like the page (`admitCodePage`) under their own rate-limit IDs with the page's limits, answer missing
 * and inaccessible Code alike, and compare the delivered version before anything else is read.
 */
export function createCodePageRoutes(deps = { version: codeRequestVersion }) {
  const router = new Hono<AuthContext>();
  router.use("*", middleware.noTransform(), auth.requireRole("*"));
  const admitted = async (
    c: Context<AuthContext>,
    input: { codeId: string; path: string; version: string },
    run: (admission: Exclude<Awaited<ReturnType<typeof admitCodePage>>, Response>, signal: AbortSignal) => Promise<Response>,
  ): Promise<Response> => {
    c.header("Cache-Control", "no-store");
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(CODE_REQUEST_LIMITS.timeoutMs)]);
    try {
      if (!isPagePath(input.codeId, input.path)) return c.json(badInput(), 400);
      const admission = await admitCodePage(c, {
        codeId: input.codeId,
        path: input.path,
        signal,
        version: deps.version,
        select: selectLabelRoute,
        limits: { member: "code-page-label-member", public: "code-page-label-public" },
      });
      if (admission instanceof Response) return admission;
      // Rights are checked again on every request; only then may a stale page learn that it is stale.
      if (!checkCodePageVersionValue(input.codeId, admission.version.versionId, input.version))
        return c.json({ code: "code_page_changed" }, 409);
      return await run(admission, signal);
    } catch (error) {
      if (error instanceof CodePageChangedError) return c.json({ code: "code_page_changed" }, 409);
      if (signal.aborted) return c.json({ code: "code_request_timeout" }, 504);
      if (error instanceof CodeRequestError) return c.json({ code: error.code }, error.status);
      return c.json({ code: "code_request_failed" }, 503);
    }
  };
  return router
    .post(
      "/provenance",
      auth.readOnly,
      middleware.openapi({ tags: ["Code"], summary: "Read what the label of a Code page tells this viewer" }),
      v("json", codePageProvenanceRoutes.read.input, badInput),
      async (c) => {
        const input = c.req.valid("json");
        return admitted(c, input, async (admission, signal) => {
          const data = await readCodePageProvenance({
            codeId: input.codeId,
            path: input.path,
            admission,
            authority: admission.member ? auth.getAuthority(c) : null,
            locale: getLocale(c),
            signal,
          });
          return c.json({ data: codePageProvenanceRoutes.read.data.parse(data) });
        });
      },
    )
    .post(
      "/report",
      middleware.openapi({ tags: ["Code"], summary: "Report a Code page to the administrators of this Cloud" }),
      v("json", codePageProvenanceRoutes.report.input, badInput),
      async (c) => {
        const input = c.req.valid("json");
        const actor = c.get("actor");
        // Visitors without an account and guests report through the Cloud's legal pages, not here (F28). This needs
        // no Code, so it answers the same for every page.
        if (
          actor?.kind !== "user" ||
          !isCodePageMember({ actor, accessSubject: c.get("accessSubject"), credentialKind: c.get("credentialKind") })
        )
          return c.json({ code: "code_report_members_only" }, 403);
        if (/\u0000/.test(input.text)) return c.json(badInput(), 400);
        return admitted(c, input, async (_admission, signal) => {
          const limiter = ratelimit({ id: "code-page-reports", windowSecs: 3600, limit: CODE_PAGE_REPORTS_PER_HOUR });
          if ((await waitCodeRequest(limiter.check(`user:${actor.user.id}`), signal)).limited) {
            c.header("Retry-After", "3600");
            return c.json({ code: "code_report_rate_limit" }, 429);
          }
          const data = await waitCodeRequest(
            fileCodePageReport({
              codeId: input.codeId,
              path: input.path,
              reporterId: actor.user.id,
              reason: input.reason,
              text: input.text,
              key: input.key,
              locale: getLocale(c),
            }),
            signal,
          );
          return c.json({ data });
        });
      },
    );
}
