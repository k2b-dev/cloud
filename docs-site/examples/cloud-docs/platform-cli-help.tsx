import {
  type AccessCommandAdapter,
  arg,
  type CloudCliTableColumn,
  command,
  confirmFlag,
  createAccessCommands,
  defineCliCommands,
  flag,
  paginationFlags,
  printRows,
  printStructured,
  readCliInput,
} from "@valentinkolb/cloud/cli";
import type { AccessEntry, Principal } from "@valentinkolb/cloud/contracts";
import { defineHelp } from "@valentinkolb/cloud/server";

type InventoryItem = {
  [key: string]: unknown;
  id: string;
  name: string;
  quantity: number;
};

type InventoryResource = {
  id: string;
  label: string;
};

const itemColumns: CloudCliTableColumn<InventoryItem>[] = [
  { key: "id", label: "ID" },
  { key: "name", label: "NAME" },
  { key: "quantity", label: "QUANTITY" },
];

const accessAdapter: AccessCommandAdapter<InventoryResource> = {
  resourceLabel: "item",
  resourceArgDescription: "Item ID",
  allowedPermissions: ["read", "write", "admin"],
  allowServiceAccounts: true,
  resolveResource: async (ctx, args) => {
    const id = args[0];
    if (!id) throw new Error("Pass an item ID.");
    const item = await ctx.readJson<InventoryItem>(await ctx.fetch(`/api/inventory/items/${encodeURIComponent(id)}`));
    return { id: item.id, label: item.name };
  },
  list: async (ctx, item) => ctx.readJson<AccessEntry[]>(await ctx.fetch(`/api/inventory/items/${encodeURIComponent(item.id)}/access`)),
  grant: async (ctx, item, principal: Principal, permission) =>
    ctx.readJson<AccessEntry>(
      await ctx.fetch(`/api/inventory/items/${encodeURIComponent(item.id)}/access`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ principal, permission }),
      }),
    ),
  update: async (ctx, item, accessId, permission) => {
    const response = await ctx.fetch(`/api/inventory/items/${encodeURIComponent(item.id)}/access/${encodeURIComponent(accessId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permission }),
    });
    if (!response.ok) throw new Error(`Failed to update access (${response.status}).`);
  },
  revoke: async (ctx, item, accessId) => {
    const response = await ctx.fetch(`/api/inventory/items/${encodeURIComponent(item.id)}/access/${encodeURIComponent(accessId)}`, {
      method: "DELETE",
    });
    if (!response.ok) throw new Error(`Failed to revoke access (${response.status}).`);
  },
};

export const inventoryCli = defineCliCommands({
  name: "inventory",
  summary: "Manage inventory items.",
  requiresCloud: true,
  commands: [
    command("items list", {
      summary: "List inventory items",
      flags: {
        search: flag.string({ description: "Filter by name" }),
        ...paginationFlags(),
      },
      async run({ ctx, flags }) {
        const query = new URLSearchParams({
          page: String(flags.page ?? 1),
          per_page: String(flags.perPage ?? 50),
        });
        if (flags.search) query.set("search", flags.search);

        const page = await ctx.readJson<{
          items: InventoryItem[];
          page: number;
          perPage: number;
          total: number;
        }>(await ctx.fetch(`/api/inventory/items?${query}`));
        printRows(ctx, page, page.items, itemColumns);
      },
    }),
    command("items get", {
      summary: "Show one inventory item",
      args: {
        item: arg.required({ description: "Item ID" }),
      },
      async run({ ctx, args }) {
        const item = await ctx.readJson<InventoryItem>(await ctx.fetch(`/api/inventory/items/${encodeURIComponent(args.item)}`));
        if (printStructured(ctx, item)) return;
        ctx.print(`${item.name} (${item.quantity})`);
      },
    }),
    command("items import", {
      summary: "Import inventory items",
      flags: {
        body: flag.input({
          description: "JSON payload, a file, or stdin",
          required: true,
        }),
      },
      async run({ ctx, flags }) {
        const body = await readCliInput(flags.body, {
          label: "inventory JSON",
          required: true,
        });
        const imported = await ctx.readJson<{ imported: number }>(
          await ctx.fetch("/api/inventory/items/import", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
        );
        if (printStructured(ctx, imported)) return;
        ctx.print(`Imported ${imported.imported} items.`);
      },
    }),
    command("items delete", {
      summary: "Delete an inventory item",
      args: {
        item: arg.required({ description: "Item ID" }),
      },
      flags: {
        yes: confirmFlag(),
      },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to delete without --yes.");
        const response = await ctx.fetch(`/api/inventory/items/${encodeURIComponent(args.item)}`, { method: "DELETE" });
        if (!response.ok) throw new Error(`Failed to delete item (${response.status}).`);
        if (printStructured(ctx, { id: args.item, deleted: true })) return;
        ctx.print(`Deleted ${args.item}.`);
      },
    }),
    ...createAccessCommands(accessAdapter),
  ],
});

const startHelp = `---
id: inventory-start
title: Start with Inventory
icon: ti ti-package
description: Create and update inventory items.
order: 10
---

# Start with Inventory

**First steps**

## Create an item {icon="plus"}

Open Inventory and choose **New item**.

:::steps
1. Enter a name.
2. Set the initial quantity.
3. Choose **Create**.
:::

:::warning Before deleting
Deleting an item cannot be undone.
:::`;

export const inventoryHelp = defineHelp({
  documents: [startHelp],
});
