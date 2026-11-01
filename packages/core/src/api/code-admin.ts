import {
  type AuthContext,
  auth,
  getLocale,
  middleware,
  REQUEST_IDLE_TIMEOUT_MAX_SECONDS,
  REQUEST_IDLE_TIMEOUT_SECONDS,
  setRequestTimeout,
  v,
} from "@k2b/cloud/server";
import { Hono } from "hono";
import { z } from "zod";
import { type CodeContext, CodeDataError } from "../code/access";
import { CodeExplanationUnavailableError, codeAdminOwnerNames, explainCodeVersion } from "../code/admin";
import { CodeIdSchema } from "../code/contracts";
import { previewCodePolicy, readCodePolicy, requireCodePolicyAdmin, updateCodePolicy } from "../code/policy";
import { codePolicyContracts } from "../code/policy-contracts";
import { CodeVersionBindingSchema } from "../code/version-contracts";
import { CodeVersionError, decideCodeVersion, setCodePaused } from "../code/versions";

/** Browser routes for Administration › Code. They call the same C7/C8 services as the `core.code.*` capabilities. */
export const codeAdminContracts = {
  decide: { input: z.object({ binding: CodeVersionBindingSchema, approved: z.boolean() }).strict() },
  read: { input: z.object({}).strict() },
  explain: { input: z.object({ versionId: z.uuid() }).strict(), data: z.object({ text: z.string() }).strict() },
  pause: { input: z.object({ codeId: CodeIdSchema, paused: z.boolean() }).strict() },
  preview: { input: codePolicyContracts.preview.input },
  update: { input: codePolicyContracts.update.input },
} as const;

export const createCodeAdminRoutes = () => {
  const router = new Hono<AuthContext>();
  router.use("*", middleware.noTransform(), auth.requireRole("admin"));
  const context = (c: Parameters<typeof auth.getAuthority>[0]): CodeContext => ({
    authority: auth.getAuthority(c),
    locale: getLocale(c),
    signal: c.req.raw.signal,
  });
  const run = async <T>(action: () => Promise<T>) => {
    try {
      return Response.json({ data: await action() }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof CodeVersionError) return Response.json({ code: error.code, message: error.message }, { status: 409 });
      if (error instanceof CodeDataError)
        return Response.json(
          { code: error.code, message: error.message },
          { status: error.code === "FORBIDDEN" ? 403 : error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" ? 409 : 400 },
        );
      if (error instanceof z.ZodError)
        return Response.json({ code: "BAD_INPUT", message: "Invalid Code administration input." }, { status: 400 });
      throw error;
    }
  };
  return router
    .post(
      "/decide",
      auth.requireOAuthScope("write", "admin"),
      middleware.openapi({ tags: ["Code"], summary: "Approve or reject one exact Code version as a Cloud administrator" }),
      v("json", codeAdminContracts.decide.input),
      (c) => {
        const input = c.req.valid("json");
        return run(() => decideCodeVersion(input.binding, input.approved, context(c)));
      },
    )
    .post(
      "/explain",
      auth.requireOAuthScope("write", "admin"),
      middleware.openapi({ tags: ["Code"], summary: "Explain one Code version to its reviewer in plain language" }),
      v("json", codeAdminContracts.explain.input),
      async (c) => {
        // A model answers well past the default idle budget.
        setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_MAX_SECONDS);
        try {
          return await run(() => explainCodeVersion(c.req.valid("json").versionId, context(c)));
        } catch (error) {
          if (error instanceof CodeExplanationUnavailableError)
            return Response.json({ code: "code_explanation_unavailable", message: "No explanation could be generated." }, { status: 503 });
          throw error;
        } finally {
          setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
        }
      },
    )
    .post(
      "/pause",
      auth.requireOAuthScope("write", "admin"),
      middleware.openapi({ tags: ["Code"], summary: "Pause or resume any Code as a Cloud administrator" }),
      v("json", codeAdminContracts.pause.input),
      (c) => {
        const input = c.req.valid("json");
        return run<{ state: "paused" | "active" }>(() =>
          input.paused ? setCodePaused(input.codeId, true, context(c)) : setCodePaused(input.codeId, false, context(c)),
        );
      },
    )
    .post(
      "/policy/read",
      auth.readOnly,
      middleware.openapi({ tags: ["Code"], summary: "Read the complete Code policy as a Cloud administrator" }),
      v("json", codeAdminContracts.read.input),
      (c) =>
        run(() => {
          const ctx = context(c);
          requireCodePolicyAdmin(ctx);
          return readCodePolicy(ctx);
        }),
    )
    .post(
      "/policy/preview",
      auth.readOnly,
      middleware.openapi({ tags: ["Code"], summary: "Preview which Code a policy change pauses" }),
      v("json", codeAdminContracts.preview.input),
      (c) =>
        run(async () => {
          const ctx = context(c);
          const preview = await previewCodePolicy(c.req.valid("json"), ctx);
          return {
            ...preview,
            owners: await codeAdminOwnerNames(
              preview.items.map((item) => item.codeId),
              ctx,
            ),
          };
        }),
    )
    .post(
      "/policy/update",
      auth.requireOAuthScope("write", "admin"),
      middleware.openapi({ tags: ["Code"], summary: "Replace the Code policy at a known revision" }),
      v("json", codeAdminContracts.update.input),
      (c) => run(() => updateCodePolicy(c.req.valid("json"), context(c))),
    );
};
