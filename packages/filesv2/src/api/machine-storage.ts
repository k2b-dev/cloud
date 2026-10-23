import { type AuthContext, middleware, requiresAdmin, respond, v } from "@k2b/cloud/server";
import { ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { z } from "zod";
import { requestCall } from "../files-call";
import { MachineStorageInputSchema, StorageGrantInputSchema } from "../machine-contracts";
import { filesService as service } from "../service";

const id = v("param", z.object({ id: z.string().uuid() }));
export const machineStorageApi = new Hono<AuthContext>()
  .get(
    "/",
    middleware.openapi({ summary: "List explicitly owned machine storage", ...requiresAdmin }),
    v("query", z.object({ after: z.string().uuid().optional() })),
    async (c) => respond(c, ok(await service.machineStorage(requestCall(c), c.req.valid("query").after))),
  )
  .post(
    "/",
    middleware.openapi({ summary: "Provision independent machine storage without granting access", ...requiresAdmin }),
    v("json", MachineStorageInputSchema),
    async (c) => respond(c, ok(await service.createMachineStorage(requestCall(c), c.req.valid("json")))),
  )
  .get(
    "/:id/grants",
    middleware.openapi({ summary: "Read storage path grants", ...requiresAdmin }),
    id,
    v("query", z.object({ after: z.string().uuid().optional() })),
    async (c) => respond(c, ok(await service.storageGrants(requestCall(c), c.req.valid("param").id, c.req.valid("query").after))),
  )
  .post(
    "/:id/grants",
    middleware.openapi({ summary: "Grant storage access", ...requiresAdmin }),
    id,
    v("json", StorageGrantInputSchema),
    async (c) => respond(c, ok(await service.grantStorage(requestCall(c), c.req.valid("param").id, c.req.valid("json")))),
  )
  .delete(
    "/:id/grants/:accessId",
    middleware.openapi({ summary: "Revoke storage access immediately", ...requiresAdmin }),
    v("param", z.object({ id: z.string().uuid(), accessId: z.string().uuid() })),
    async (c) => respond(c, ok(await service.revokeStorage(requestCall(c), c.req.valid("param").id, c.req.valid("param").accessId))),
  );
