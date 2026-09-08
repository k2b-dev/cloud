import { ok } from "@k2b/stdlib";
import { defineCapabilities } from "@valentinkolb/cloud";
import { cloudResourceClipboard } from "@valentinkolb/cloud/browser/resource-clipboard";
import { openCloudResourcePicker } from "@valentinkolb/cloud/browser/resource-picker";
import { invokeCapabilityWithDataSchema as invokeCapabilityInBrowser } from "@valentinkolb/cloud/capabilities";
import { type CapabilityCaller, invokeCapabilityWithDataSchema as invokeCapabilityOnServer } from "@valentinkolb/cloud/capabilities/server";
import { assertCapabilityManifestEvolution, compileCapabilityManifest } from "@valentinkolb/cloud/capabilities/testing";
import { type AccessSubject, UniversalSearchDataSchema, UniversalSearchInputSchema } from "@valentinkolb/cloud/contracts";
import { z } from "zod";

export const inventoryResourceClipboard = cloudResourceClipboard;

type Item = {
  id: string;
  ownerId: string;
  name: string;
  quantity: number;
};

const itemId = "11111111-1111-4111-8111-111111111111";
const items = new Map<string, Item>([
  [
    itemId,
    {
      id: itemId,
      ownerId: "user-42",
      name: "USB-C adapter",
      quantity: 4,
    },
  ],
]);

const visibleItem = (id: string, subject: AccessSubject): Item | null => {
  const item = items.get(id);
  return item && subject.type === "user" && subject.userId === item.ownerId ? item : null;
};

const visibleItems = (subject: AccessSubject): Item[] =>
  [...items.values()].filter((item) => subject.type === "user" && subject.userId === item.ownerId);

export const inventoryCapabilities = defineCapabilities({
  protocolVersion: 1,
  types: {
    item: {
      title: "Inventory item",
      description: "One item in the inventory catalog.",
      icon: "ti ti-package",
    },
  },
  queries: {
    "item.get": {
      title: "Get inventory item",
      description: "Read one visible inventory item by stable ID.",
      input: z
        .object({
          itemId: z.string().uuid().describe("Stable inventory item UUID."),
        })
        .strict(),
      data: z
        .object({
          id: z.string().uuid(),
          name: z.string(),
          quantity: z.number().int(),
        })
        .strict(),
      openWorld: false,
      run: async ({ itemId }, context) => {
        const item = visibleItem(itemId, context.accessSubject);
        if (!item) {
          return {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: "Inventory item not found",
              status: 404,
            },
          } as const;
        }
        return ok({
          data: { id: item.id, name: item.name, quantity: item.quantity },
          refs: [{ type: "inventory.item", id: item.id }],
          links: [{ rel: "open", href: `/app/inventory/items/${item.id}` }],
        });
      },
    },
    search: {
      title: "Search inventory",
      description: "Find visible inventory items by name.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      universalSearch: {
        tags: [
          {
            tag: "inventory",
            title: "Inventory",
            description: "Search inventory items.",
            aliases: ["stock", "sku"],
          },
        ],
      },
      openWorld: false,
      run: async ({ query, limit }, context) => {
        const normalized = query.trim().toLowerCase();
        return ok({
          data: visibleItems(context.accessSubject)
            .filter((item) => !normalized || item.name.toLowerCase().includes(normalized))
            .slice(0, limit)
            .map((item) => ({
              ref: { type: "inventory.item", id: item.id },
              title: item.name,
              preview: `${item.quantity} in stock`,
              icon: "ti ti-package",
              priority: 7,
              metadata: [{ label: "Type", value: "Inventory item" }],
              links: [
                {
                  rel: "open" as const,
                  href: `/app/inventory/items/${item.id}`,
                },
              ],
            })),
        });
      },
    },
  },
  actions: {
    "item.rename": {
      title: "Rename inventory item",
      description: "Rename one inventory item the caller may edit.",
      input: z
        .object({
          itemId: z.string().uuid().describe("Stable inventory item UUID."),
          name: z.string().trim().min(1).max(120).describe("New item name."),
        })
        .strict(),
      data: z.object({ id: z.string().uuid(), name: z.string() }).strict(),
      destructive: true,
      openWorld: false,
      idempotency: "none",
      review: async ({ itemId, name }, context) => {
        const item = visibleItem(itemId, context.accessSubject);
        if (!item) {
          return {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: "Inventory item not found",
              status: 404,
            },
          } as const;
        }
        return ok({
          message: "This inventory item will be renamed.",
          details: [
            { label: "Current name", value: item.name },
            { label: "New name", value: name },
          ],
          links: [{ rel: "open", href: `/app/inventory/items/${item.id}` }],
        });
      },
      run: async ({ itemId, name }, context) => {
        const item = visibleItem(itemId, context.accessSubject);
        if (!item) {
          return {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: "Inventory item not found",
              status: 404,
            },
          } as const;
        }
        const renamed = { ...item, name };
        items.set(itemId, renamed);
        return ok({
          data: { id: renamed.id, name: renamed.name },
          refs: [{ type: "inventory.item", id: renamed.id }],
          links: [
            {
              rel: "edit",
              href: `/app/inventory/items/${renamed.id}/edit`,
            },
          ],
        });
      },
    },
  },
});

const inventoryItemDataSchema = z.object({ id: z.string().uuid(), name: z.string(), quantity: z.number().int() }).passthrough();

export const readInventoryItemInBrowser = (itemId: string) =>
  invokeCapabilityInBrowser({ appId: "inventory", capabilityId: "item.get", kind: "query", input: { itemId } }, inventoryItemDataSchema);

export const chooseInventoryItem = () =>
  openCloudResourcePicker({
    title: "Choose inventory item",
    initialAppId: "inventory",
    requireReader: true,
  });

export const readInventoryItemOnServer = (itemId: string, caller: CapabilityCaller) =>
  invokeCapabilityOnServer(
    { appId: "inventory", capabilityId: "item.get", kind: "query", input: { itemId } },
    inventoryItemDataSchema,
    caller,
  );

export const inventoryCapabilityManifest = compileCapabilityManifest("inventory", inventoryCapabilities);

export const assertInventoryCapabilityEvolution = (previous: typeof inventoryCapabilityManifest) =>
  assertCapabilityManifestEvolution(previous, inventoryCapabilityManifest);
