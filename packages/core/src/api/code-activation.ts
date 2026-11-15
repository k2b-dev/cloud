import { type AuthContext, auth, getLocale, middleware, v } from "@k2b/cloud/server";
import { Hono } from "hono";
import { ZodError } from "zod";
import { type CodeContext, CodeDataError } from "../code/access";
import { activateCodeVersion, cancelCodeActivation, previewCodeActivation, readCodeActivation } from "../code/activation";
import { codeActivationContracts } from "../code/activation-contracts";
import { codeAuthoringContracts } from "../code/authoring-contracts";
import { listCodeCleanupJobs } from "../code/lifecycle";
import { codeLifecycleContracts } from "../code/lifecycle-contracts";
import { readCodeReview } from "../code/review";
import { CodeVersionError, withdrawCodeVersion } from "../code/versions";

/** Interactive credentials enter only Core. Invocation, sandbox, API-key and phone identities cannot activate. */
export const createCodeActivationRoutes = () => {
  const router = new Hono<AuthContext>();
  router.use("*", middleware.noTransform(), auth.requireRole("authenticated"));
  const run = async <T>(context: CodeContext, action: (ctx: CodeContext) => Promise<T>) => {
    try {
      return Response.json({ data: await action(context) }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof ZodError)
        return Response.json({ code: "BAD_INPUT", message: "Invalid Code activation input." }, { status: 400 });
      if (error instanceof CodeVersionError) return Response.json({ code: error.code, message: error.message }, { status: 409 });
      if (error instanceof CodeDataError)
        return Response.json(
          { code: error.code, message: error.message },
          { status: error.code === "FORBIDDEN" ? 403 : error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" ? 409 : 400 },
        );
      throw error;
    }
  };
  const context = (c: Parameters<typeof auth.getAuthority>[0]): CodeContext => ({
    authority: auth.getAuthority(c),
    locale: getLocale(c),
    signal: c.req.raw.signal,
  });
  return router
    .post(
      "/cleanup",
      auth.readOnly,
      middleware.openapi({ tags: ["Code"], summary: "Read pending Code cleanup jobs as a Cloud administrator" }),
      v("json", codeLifecycleContracts.cleanup.input),
      (c) => run(context(c), (ctx) => listCodeCleanupJobs(c.req.valid("json"), ctx)),
    )
    .post(
      "/activate",
      auth.requireOAuthScope("write", "admin"),
      middleware.openapi({ tags: ["Code"], summary: "Start one durable Code activation" }),
      v("json", codeActivationContracts.activate.input),
      (c) => run(context(c), (ctx) => activateCodeVersion(c.req.valid("json"), ctx)),
    )
    .post(
      "/activation/preview",
      auth.readOnly,
      middleware.openapi({ tags: ["Code"], summary: "Check what switching on a Code version would do for this person" }),
      v("json", codeActivationContracts.preview.input),
      (c) => run(context(c), (ctx) => previewCodeActivation(c.req.valid("json"), ctx)),
    )
    .post(
      "/activation/read",
      auth.readOnly,
      middleware.openapi({ tags: ["Code"], summary: "Read a durable Code activation" }),
      v("json", codeActivationContracts.read.input),
      (c) => run(context(c), (ctx) => readCodeActivation(c.req.valid("json"), ctx)),
    )
    .post(
      "/review",
      auth.readOnly,
      middleware.openapi({ tags: ["Code"], summary: "Read the review of a Code version without its places in the source" }),
      v("json", codeAuthoringContracts.review.input),
      // The chat's version card shows a decision, its message and comments as text: no file or line in this answer.
      (c) => run(context(c), (ctx) => readCodeReview(c.req.valid("json"), ctx, { anchors: false })),
    )
    .post(
      "/withdraw",
      auth.requireOAuthScope("write", "admin"),
      middleware.openapi({ tags: ["Code"], summary: "Withdraw a Code version that still waits for an administrator" }),
      v("json", codeAuthoringContracts.withdraw.input),
      // The browser learns only that it worked; the receipt with the version's files stays with `cld`.
      (c) =>
        run(context(c), async (ctx) => {
          await withdrawCodeVersion(c.req.valid("json"), ctx);
          return { withdrawn: true as const };
        }),
    )
    .post(
      "/activation/cancel",
      auth.requireOAuthScope("write", "admin"),
      middleware.openapi({ tags: ["Code"], summary: "Cancel an unfinished Code activation" }),
      v("json", codeActivationContracts.cancel.input),
      (c) => run(context(c), (ctx) => cancelCodeActivation(c.req.valid("json"), ctx)),
    );
};
