import { type Context, Hono, type MiddlewareHandler } from "hono";
import { describeRoute, validator } from "hono-openapi";
import { z } from "zod";
import {
  AdminStorageBucketSchema,
  StorageBucketCreateSchema,
  StorageBucketErrorSchema,
  StorageBucketIdSchema,
  StorageBucketRestoreSchema,
  StorageBucketUpdateSchema,
  StorageBucketUsageSchema,
} from "../contracts/storage-buckets";
import { type AuthContext, auth, jsonResponse, requiresAdmin } from "../server";
import { noTransform } from "../server/middleware/no-transform";
import { type StorageBucketAuditContext, StorageBucketError, storageBucketStore } from "../services/storage-buckets/store";

const context = (c: Context<AuthContext>): StorageBucketAuditContext => ({
  actor: { userId: c.get("user").id, uid: c.get("user").uid, provider: c.get("user").provider, roles: c.get("user").roles },
  requestId: c.req.header("x-request-id"),
});
const validate = <Target extends "param" | "json", Schema extends z.ZodType>(target: Target, schema: Schema) =>
  validator(target, schema, (result, c) => {
    if (!result.success)
      return c.json(
        { code: "storage_bucket_invalid", message: "Invalid storage bucket configuration or ID. Check the required fields." },
        400,
      );
  });
const param = z.object({ id: StorageBucketIdSchema });
const response = z.object({ bucket: AdminStorageBucketSchema });
const route = (summary: string, schema: z.ZodType = response, status: 200 | 201 = 200) =>
  describeRoute({
    summary,
    tags: ["Storage"],
    ...requiresAdmin,
    responses: {
      [status]: jsonResponse(schema, summary),
      400: jsonResponse(StorageBucketErrorSchema, "Invalid bucket configuration"),
      404: jsonResponse(StorageBucketErrorSchema, "Unknown bucket"),
      409: jsonResponse(StorageBucketErrorSchema, "Bucket changed or disconnected"),
      502: jsonResponse(StorageBucketErrorSchema, "Storage unavailable"),
    },
  });

export const createAdminStorageRoutes = (authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("admin")) =>
  new Hono<AuthContext>()
    .use("*", noTransform())
    .use("*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    })
    .use("*", authenticate)
    .onError((error, c) => {
      if (error instanceof StorageBucketError)
        return c.json({ code: error.code, message: error.message, ...(error.current ? { current: error.current } : {}) }, error.status);
      // Drivers may embed credentials or request bodies in errors: log only the error class and code, never the message.
      console.error(
        "[storage] administration request failed",
        error.name,
        "code" in error && typeof error.code === "string" ? error.code : "",
      );
      return c.json(
        { code: "storage_bucket_unreachable", message: "Storage administration is unavailable. Check database access and retry." },
        502,
      );
    })
    .get("/buckets", route("List storage buckets", z.object({ items: z.array(AdminStorageBucketSchema) })), async (c) =>
      c.json({ items: await storageBucketStore.list() }),
    )
    .post("/buckets", route("Connect a storage bucket", response, 201), validate("json", StorageBucketCreateSchema), async (c) =>
      c.json({ bucket: await storageBucketStore.create(c.req.valid("json"), context(c)) }, 201),
    )
    .put(
      "/buckets/:id",
      route("Update a storage bucket"),
      validate("param", param),
      validate("json", StorageBucketUpdateSchema),
      async (c) => c.json({ bucket: await storageBucketStore.update(c.req.valid("param").id, c.req.valid("json"), context(c)) }),
    )
    .post("/buckets/:id/test", route("Test a storage bucket"), validate("param", param), async (c) =>
      c.json({ bucket: await storageBucketStore.test(c.req.valid("param").id, context(c)) }),
    )
    .delete("/buckets/:id", route("Disconnect a storage bucket"), validate("param", param), async (c) =>
      c.json({ bucket: await storageBucketStore.remove(c.req.valid("param").id, context(c)) }),
    )
    .post(
      "/buckets/:id/restore",
      route("Reconnect a storage bucket"),
      validate("param", param),
      validate("json", StorageBucketRestoreSchema),
      async (c) => c.json({ bucket: await storageBucketStore.restore(c.req.valid("param").id, c.req.valid("json"), context(c)) }),
    )
    .get(
      "/buckets/:id/usage",
      route("List application areas in a storage bucket", StorageBucketUsageSchema),
      validate("param", param),
      async (c) => c.json(await storageBucketStore.usage(c.req.valid("param").id)),
    );
export default createAdminStorageRoutes();
