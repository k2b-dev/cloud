import { type AuthContext, auth, getLocale, middleware, v } from "@k2b/cloud/server";
import { Hono } from "hono";
import { ZodError } from "zod";
import { type CodeContext, CodeDataError } from "../code/access";
import { activateCodeVersion, cancelCodeActivation, readCodeActivation } from "../code/activation";
import { codeActivationContracts } from "../code/activation-contracts";
import { reconcileCodeAccess } from "../code/activation-maintenance";
import { CodeVersionError } from "../code/versions";

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
      "/activate",
      auth.requireOAuthScope("write", "admin"),
      middleware.openapi({ tags: ["Code"], summary: "Start one durable Code activation" }),
      v("json", codeActivationContracts.activate.input),
      (c) => run(context(c), (ctx) => activateCodeVersion(c.req.valid("json"), ctx)),
    )
    .post(
      "/activation/read",
      auth.readOnly,
      middleware.openapi({ tags: ["Code"], summary: "Read a durable Code activation" }),
      v("json", codeActivationContracts.read.input),
      (c) => run(context(c), (ctx) => readCodeActivation(c.req.valid("json"), ctx)),
    )
    .post(
      "/activation/cancel",
      auth.requireOAuthScope("write", "admin"),
      middleware.openapi({ tags: ["Code"], summary: "Cancel an unfinished Code activation" }),
      v("json", codeActivationContracts.cancel.input),
      (c) => run(context(c), (ctx) => cancelCodeActivation(c.req.valid("json"), ctx)),
    )
    .post(
      "/access",
      auth.readOnly,
      middleware.openapi({ tags: ["Code"], summary: "Reconcile explicit target access without restoring grants" }),
      v("json", codeActivationContracts.access.input),
      (c) => run(context(c), (ctx) => reconcileCodeAccess(c.req.valid("json"), ctx)),
    );
};
