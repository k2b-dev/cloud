import { z } from "zod";
import { compileCapabilityManifest } from "../capabilities/testing";
import { CloudResourceReaderViewSchema, defineCapabilities } from "../contracts/capabilities";

/** Fictional provider: no installed application is a special case in the SDK. */
export function sdkFixture(appId = "work-shop") {
  return compileCapabilityManifest(
    appId,
    defineCapabilities({
      protocolVersion: 2,
      types: {
        workshop: { title: "Workshop", description: "A workshop.", reader: "workshop.read", access: { readable: async () => [] } },
        item: { title: "Item", description: "An item." },
      },
      queries: {
        "workshop.read": {
          title: "Read workshop",
          description: "Read the canonical workshop view.",
          openWorld: false,
          input: z.object({ id: z.string().describe("Workshop ID.") }).strict(),
          data: z.object({ view: CloudResourceReaderViewSchema.pick({ title: true, permission: true }) }).strict(),
          run: () => ({ ok: true, data: { data: { view: { title: "Workshop", permission: "admin" } } } }),
        },
        "stock.list": {
          title: "Stock",
          description: "Read stock in a workshop.",
          target: "workshop",
          openWorld: false,
          input: z.object({ cursor: z.string().optional().describe("Page cursor.") }).strict(),
          data: z.object({ rows: z.array(z.object({ id: z.string(), state: z.enum(["ready", "empty"]) })), next: z.string().nullable() }),
          run: () => ({ ok: true, data: { data: { rows: [], next: null } } }),
        },
        "catalog.list": {
          title: "Catalog",
          description: "Read the application catalog.",
          openWorld: false,
          input: z.object({}).strict(),
          data: z.array(z.string()),
          run: () => ({ ok: true, data: { data: [] } }),
        },
        "stock.export": {
          title: "Export",
          description: "Export workshop stock.",
          target: "workshop",
          openWorld: false,
          input: z.object({}).strict(),
          data: z.object({}).strict(),
          stream: { direction: "read", maxBytes: 100, read: async () => new Response("stock") },
          run: () => ({ ok: true, data: { data: {} } }),
        },
      },
      actions: {
        "item.create": {
          title: "Create item",
          description: "Create an item in a workshop.",
          target: "workshop",
          input: z
            .object({
              title: z.string().describe("Item title."),
              details: z
                .discriminatedUnion("kind", [
                  z.object({ kind: z.literal("note").describe("Detail kind."), text: z.string().describe("Note text.") }),
                  z.object({ kind: z.literal("count").describe("Detail kind."), count: z.number().describe("Item count.") }),
                ])
                .optional()
                .describe("Item details."),
            })
            .strict(),
          data: z.object({ id: z.string() }),
          destructive: false,
          openWorld: false,
          idempotency: "required",
          run: () => ({ ok: true, data: { data: { id: "item-fixed" } } }),
        },
        "item.move": {
          title: "Move item",
          description: "Move an item to a different workshop.",
          target: "workshop",
          refs: { destination: "workshop" },
          input: z.object({ itemId: z.string().describe("Item to move.") }).strict(),
          data: z.object({ moved: z.boolean() }),
          destructive: false,
          openWorld: false,
          idempotency: "none",
          run: () => ({ ok: true, data: { data: { moved: true } } }),
        },
        "item.inspect": {
          title: "Inspect",
          description: "Inspect one item.",
          target: "item",
          input: z.object({}).strict(),
          data: z.object({ ok: z.boolean() }),
          destructive: false,
          openWorld: false,
          idempotency: "none",
          run: () => ({ ok: true, data: { data: { ok: true } } }),
        },
        "outside.change": {
          title: "Outside",
          description: "Change a foreign resource.",
          target: "workshop",
          code: false,
          input: z.object({}).strict(),
          data: z.object({}).strict(),
          destructive: false,
          openWorld: false,
          idempotency: "none",
          run: () => ({ ok: true, data: { data: {} } }),
        },
      },
      events: {
        changed: {
          title: "Changed",
          description: "Workshop changed.",
          version: 1,
          subject: "workshop",
          schema: z.object({ title: z.string().max(120) }).strict(),
        },
        hidden: {
          title: "Hidden",
          description: "Not available for Code.",
          version: 1,
          subject: "workshop",
          automation: false,
          schema: z.object({}).strict(),
        },
      },
    }),
  );
}
