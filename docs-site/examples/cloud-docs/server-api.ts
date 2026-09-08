import { api } from "@valentinkolb/cloud/browser";
import { createPagination, ErrorResponseSchema, PaginationQuerySchema, PaginationResponseSchema } from "@valentinkolb/cloud/contracts";
import {
  type AccessSubject,
  type AuthContext,
  auth,
  err,
  fail,
  jsonResponse,
  middleware,
  ok,
  type Result,
  respond,
  respondMessage,
  v,
} from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";

const InventoryItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  quantity: z.number().int(),
});

const CreateInventoryItemSchema = InventoryItemSchema.omit({ id: true });
const ItemParamSchema = z.object({ id: z.string().uuid() });
const ListItemsQuerySchema = PaginationQuerySchema.extend({
  search: z.string().trim().max(100).optional(),
  sort: z.enum(["name", "quantity"]).default("name"),
  direction: z.enum(["asc", "desc"]).default("asc"),
});
const InventoryListSchema = z.object({
  items: z.array(InventoryItemSchema),
  pagination: PaginationResponseSchema,
});

type InventoryItem = z.infer<typeof InventoryItemSchema>;
type CreateInventoryItem = z.infer<typeof CreateInventoryItemSchema>;

type InventoryRepository = {
  count(input: { search?: string; accessSubject: AccessSubject }): Promise<number>;
  create(input: CreateInventoryItem & { accessSubject: AccessSubject }): Promise<InventoryItem>;
  delete(input: { id: string; accessSubject: AccessSubject }): Promise<boolean>;
  find(input: { id: string; accessSubject: AccessSubject }): Promise<InventoryItem | null>;
  list(input: {
    search?: string;
    sort: "name" | "quantity";
    direction: "asc" | "desc";
    limit: number;
    offset: number;
    accessSubject: AccessSubject;
  }): Promise<InventoryItem[]>;
};

export const createInventoryService = (repository: InventoryRepository) => ({
  create: async (input: CreateInventoryItem & { accessSubject: AccessSubject }): Promise<Result<InventoryItem>> =>
    ok(await repository.create(input)),

  delete: async (input: { id: string; accessSubject: AccessSubject }): Promise<Result<void>> => {
    const deleted = await repository.delete(input);
    return deleted ? ok() : fail(err.notFound("Inventory item"));
  },

  list: async (input: {
    page: number;
    perPage: number;
    search?: string;
    sort: "name" | "quantity";
    direction: "asc" | "desc";
    accessSubject: AccessSubject;
  }): Promise<Result<z.infer<typeof InventoryListSchema>>> => {
    const offset = (input.page - 1) * input.perPage;
    const [total, items] = await Promise.all([
      repository.count(input),
      repository.list({
        ...input,
        limit: input.perPage,
        offset,
      }),
    ]);
    return ok({
      items,
      pagination: createPagination(
        {
          page: input.page,
          perPage: input.perPage,
          offset,
        },
        total,
      ),
    });
  },

  read: async (input: { id: string; accessSubject: AccessSubject }): Promise<Result<InventoryItem>> => {
    const item = await repository.find(input);
    return item ? ok(item) : fail(err.notFound("Inventory item"));
  },
});

export const createInventoryRoutes = (inventory: ReturnType<typeof createInventoryService>) => {
  const itemRoutes = new Hono<AuthContext>()
    .use("*", auth.requireRole("authenticated"))
    .get(
      "/",
      describeRoute({
        tags: ["Inventory"],
        summary: "List inventory items",
        responses: {
          200: jsonResponse(InventoryListSchema, "Inventory items"),
          400: jsonResponse(ErrorResponseSchema, "Invalid query"),
          401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        },
      }),
      v("query", ListItemsQuerySchema),
      async (c) => {
        const query = c.req.valid("query");
        return respond(
          c,
          inventory.list({
            page: query.page,
            perPage: query.per_page,
            search: query.search,
            sort: query.sort,
            direction: query.direction,
            accessSubject: c.get("accessSubject"),
          }),
        );
      },
    )
    .get(
      "/:id",
      describeRoute({
        tags: ["Inventory"],
        summary: "Read an inventory item",
        responses: {
          200: jsonResponse(InventoryItemSchema, "Inventory item"),
          400: jsonResponse(ErrorResponseSchema, "Invalid item ID"),
          401: jsonResponse(ErrorResponseSchema, "Authentication required"),
          404: jsonResponse(ErrorResponseSchema, "Inventory item not found"),
        },
      }),
      v("param", ItemParamSchema),
      async (c) =>
        respond(
          c,
          inventory.read({
            id: c.req.valid("param").id,
            accessSubject: c.get("accessSubject"),
          }),
        ),
    )
    .post(
      "/",
      describeRoute({
        tags: ["Inventory"],
        summary: "Create an inventory item",
        responses: {
          201: jsonResponse(InventoryItemSchema, "Inventory item created"),
          400: jsonResponse(ErrorResponseSchema, "Invalid input"),
          401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        },
      }),
      v("json", CreateInventoryItemSchema),
      async (c) =>
        respond(
          c,
          inventory.create({
            ...c.req.valid("json"),
            accessSubject: c.get("accessSubject"),
          }),
          201,
        ),
    )
    .delete("/:id", v("param", ItemParamSchema), async (c) =>
      respondMessage(
        c,
        inventory.delete({
          id: c.req.valid("param").id,
          accessSubject: c.get("accessSubject"),
        }),
        "Inventory item deleted",
      ),
    );

  return new Hono<AuthContext>().route("/items", itemRoutes);
};

export type InventoryApi = ReturnType<typeof createInventoryRoutes>;

export const createInventoryClient = () =>
  api.create<InventoryApi>({
    baseUrl: "/api/inventory",
  });

export const createInventoryRouter = (inventoryApi: InventoryApi) =>
  new Hono<AuthContext>()
    .use("*", middleware.logger())
    .use(
      "/api/inventory/*",
      middleware.ratelimit({
        limitPerSecond: 20,
        windowSecs: 1,
        routes: [
          {
            method: "POST",
            path: "/api/inventory/import",
            limitPerSecond: 2,
          },
        ],
      }),
    )
    .use("*", middleware.runtime())
    .use("*", middleware.settings())
    .route("/api/inventory", inventoryApi);
