import { type AuthContext, auth, jsonResponse, REQUEST_IDLE_TIMEOUT_SECONDS, requiresAdmin, setRequestTimeout } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { z } from "zod";
import { StoreCheckSchema, StoreStatusSchema } from "../../store/contracts";
import { StoreAdminError, storeAdmin } from "../../store/service";
import { StoreSaveInput, StoreSetupInput } from "../../store/validation";

const log = logger("pulse:admin-store");

const metadata = (summary: string, schema: z.ZodType, input?: z.ZodType) =>
  describeRoute({
    tags: ["Pulse administration"],
    summary,
    ...requiresAdmin,
    ...(input ? { requestBody: { required: true, content: { "application/json": { schema: resolver(input) } } } } : {}),
    responses: {
      200: jsonResponse(schema, summary),
      403: { description: "Cloud admin role required" },
      400: jsonResponse(z.object({ code: z.string() }), "Invalid input"),
      422: jsonResponse(
        z.object({ code: z.literal("STORE_CHECK_FAILED"), status: StoreCheckSchema }),
        "Candidate check failed; saved settings unchanged",
      ),
    },
  });

// Mounted at /admin/store: the middleware below must never reach the rest of the Pulse API.
const routes = new Hono<AuthContext>()
  .use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    setRequestTimeout(c, 25);
    await next();
    setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
  })
  // A Cloud admin's OAuth token with only read or write scope must not administer store credentials.
  .use("*", auth.requireOAuthScope("admin"))
  .onError((error, c) => {
    if (error instanceof StoreAdminError) return c.json({ code: error.code }, error.status);
    // Do not serialize setting, transport, SQL, or validation errors with input values.
    log.error("Store request failed", {
      errorClass: error.name || error.constructor.name,
      method: c.req.method,
      path: c.req.routePath || c.req.path,
    });
    return c.json({ code: "STORE_REQUEST_FAILED" }, 500);
  })
  .get("/", auth.requireRole("admin"), metadata("Read Pulse store status", StoreStatusSchema), async (c) =>
    c.json(await storeAdmin.status({ actor: c.get("actor"), accessSubject: c.get("accessSubject") }, c.req.raw.signal)),
  )
  .put("/", auth.requireRole("admin"), metadata("Check and save the Pulse store", StoreStatusSchema, StoreSaveInput), async (c) => {
    const parsed = StoreSaveInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ code: "INVALID_INPUT" }, 400);
    const value = await storeAdmin.save({ actor: c.get("actor"), accessSubject: c.get("accessSubject") }, parsed.data, c.req.raw.signal);
    return value.status?.ok ? c.json(value) : c.json({ code: "STORE_CHECK_FAILED", status: value.status }, 422);
  })
  // A diagnostic failure is a successful check request: HTTP 200, status.ok=false.
  .post("/check", auth.requireRole("admin"), metadata("Check the Pulse store", StoreCheckSchema), async (c) =>
    c.json(await storeAdmin.check({ actor: c.get("actor"), accessSubject: c.get("accessSubject") }, c.req.raw.signal)),
  )
  // POST keeps the chosen password (and its verifier) out of gateway/proxy URL logs.
  .post(
    "/setup-sql",
    auth.requireRole("admin"),
    metadata("Build the Pulse store setup script", z.object({ sql: z.string() }), StoreSetupInput),
    async (c) => {
      const parsed = StoreSetupInput.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ code: "INVALID_INPUT" }, 400);
      return c.json(await storeAdmin.setupSql({ actor: c.get("actor"), accessSubject: c.get("accessSubject") }, parsed.data));
    },
  );
export default routes;
