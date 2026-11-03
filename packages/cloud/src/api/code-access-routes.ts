import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { describeRoute, resolver } from "hono-openapi";
import { z } from "zod";
import { readBoundedJson } from "../_internal/bounded-json";
import { withCapabilityRequestTimeout } from "../_internal/capability-timeout";
import { invokeCodeAccess } from "../code/access-core";
import { CAPABILITY_MAX_RESULT_BYTES, capabilityResultSchema } from "../contracts/capabilities";
import { CodeAccessRemoveDataSchema, CodeAccessRemoveRequestSchema } from "../contracts/code-access";
import { type AuthContext, auth, getLocale } from "../server";

export type CodeAccessRouteDependencies = { invoke?: typeof invokeCodeAccess };

const ErrorBody = z.object({ code: z.string(), message: z.string() });
const passedStatuses = [400, 403, 404, 409, 429, 502, 503, 504] as const;
type PassedStatus = (typeof passedStatuses)[number];
const passedStatus = (status: number): PassedStatus => passedStatuses.find((candidate) => candidate === status) ?? 502;

/**
 * Session cookies are SameSite=Lax, so a sibling site could still send a credentialed simple POST. Require
 * the JSON content type, which a cross-origin page can only send after a CORS preflight, and refuse
 * requests the browser marks as coming from another site.
 */
const sameOriginJson = createMiddleware(async (c, next) => {
  const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
  const site = c.req.header("sec-fetch-site");
  if (type !== "application/json" || site === "cross-site" || site === "same-site")
    return c.json({ code: "FORBIDDEN", message: "Same-origin JSON request required" }, 403);
  await next();
});
const REMOVE_MAX_BYTES = 1024;

/**
 * Removal behind the shared rights editor admits exactly one generated `code.access.rm` at the target,
 * which decides itself whether the person manages the target.
 */
export const createCodeAccessRoutes = (dependencies: CodeAccessRouteDependencies = {}) =>
  new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.header("Cache-Control", "private, no-store");
      await next();
    })
    .post(
      "/remove",
      auth.requireRole("authenticated"),
      sameOriginJson,
      describeRoute({
        tags: ["Resources"],
        summary: "Remove one Code grant at its target through the target's code.access.rm",
        requestBody: { required: true, content: { "application/json": { schema: resolver(CodeAccessRemoveRequestSchema) } } },
        responses: {
          200: { description: "Removal result", content: { "application/json": { schema: resolver(CodeAccessRemoveDataSchema) } } },
          400: { description: "Invalid request", content: { "application/json": { schema: resolver(ErrorBody) } } },
          403: { description: "Not allowed", content: { "application/json": { schema: resolver(ErrorBody) } } },
        },
      }),
      async (c) => {
        const body = await readBoundedJson(c.req.raw, REMOVE_MAX_BYTES, c.req.raw.signal);
        const input = body.ok ? CodeAccessRemoveRequestSchema.safeParse(body.data) : null;
        if (!input?.success) return c.json({ code: "VALIDATION_FAILED", message: "Invalid Code access removal" }, 400);
        // The target may wait on its own locks; keep the response within the action budget.
        const { response, result } = await withCapabilityRequestTimeout(c, "action", async () => {
          const response = await (dependencies.invoke ?? invokeCodeAccess)({
            request: c.req.raw,
            appId: input.data.appId,
            operation: "rm",
            input: { grantId: input.data.grantId },
            authority: auth.getAuthority(c),
            locale: getLocale(c),
          });
          return { response, result: await readBoundedJson(response, CAPABILITY_MAX_RESULT_BYTES, c.req.raw.signal) };
        });
        if (response.ok) {
          const parsed = result.ok ? capabilityResultSchema(CodeAccessRemoveDataSchema, { consumer: true }).safeParse(result.data) : null;
          if (parsed?.success) return c.json(parsed.data.data, 200);
          return c.json({ code: "INVALID_APP_RESPONSE", message: "The application returned an invalid removal result" }, 502);
        }
        const error = result.ok ? ErrorBody.safeParse(result.data) : null;
        return c.json(
          error?.success
            ? { code: error.data.code, message: error.data.message }
            : { code: "UNAVAILABLE", message: "Code access removal failed" },
          passedStatus(response.status),
        );
      },
    );
