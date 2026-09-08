import { api } from "@valentinkolb/cloud/browser";
import { ErrorResponseSchema } from "@valentinkolb/cloud/contracts";
import {
  type AccessSubject,
  type AuthContext,
  auth,
  err,
  fail,
  getEffectivePermission,
  hasPermission,
  jsonResponse,
  ok,
  type ResourceAccessAdapter,
  type Result,
  respond,
  v,
} from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";

const ItemParamSchema = z.object({ id: z.string().uuid() });
const InventoryItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});

type InventoryItem = z.infer<typeof InventoryItemSchema>;

type InventoryRepository = {
  find(id: string): Promise<InventoryItem | null>;
  access: Pick<ResourceAccessAdapter, "list">;
};

export const createInventoryService = (repository: InventoryRepository) => ({
  read: async (input: { id: string; accessSubject: AccessSubject }): Promise<Result<InventoryItem>> => {
    const entries = await repository.access.list(input.id);
    const permission = await getEffectivePermission({
      accessIds: entries.map((entry) => entry.id),
      subject: input.accessSubject,
    });

    if (!hasPermission(permission, "read")) {
      return fail(err.forbidden("You do not have access to this item"));
    }

    const item = await repository.find(input.id);
    return item ? ok(item) : fail(err.notFound("Inventory item"));
  },
});

type InventoryService = ReturnType<typeof createInventoryService>;

export const createInventoryRoutes = (inventory: InventoryService) =>
  new Hono<AuthContext>().use("*", auth.requireRole("authenticated")).get(
    "/:id",
    describeRoute({
      tags: ["Inventory"],
      summary: "Read an inventory item",
      responses: {
        200: jsonResponse(InventoryItemSchema, "Inventory item"),
        400: jsonResponse(ErrorResponseSchema, "Invalid item ID"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Item not found"),
      },
    }),
    v("param", ItemParamSchema),
    async (c) =>
      respond(c, () =>
        inventory.read({
          id: c.req.valid("param").id,
          accessSubject: c.get("accessSubject"),
        }),
      ),
  );

export type InventoryApi = ReturnType<typeof createInventoryRoutes>;

export const createInventoryClient = () =>
  api.create<InventoryApi>({
    baseUrl: "/api/inventory/items",
  });
