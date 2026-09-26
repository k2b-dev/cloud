import {
  arg,
  type CloudCliContext,
  type CloudCliText,
  cliAmbiguityText,
  command,
  confirmFlag,
  defineCliCommands,
  localizeCloudCliText,
  parseCliAddress,
  printRows,
  printStructured,
} from "@k2b/cloud/cli";
import { fail } from "@k2b/stdlib";

type Item = { [key: string]: unknown; id: string; name: string; path: string };

/** Server: a path segment that matches several items. */
export const ambiguousItem = (locale: string, segment: string, matches: Item[]) =>
  fail({
    code: "CONFLICT" as const,
    status: 409 as const,
    message: localizeCloudCliText(
      locale,
      cliAmbiguityText({
        value: segment,
        resources: { en: "items", de: "Artikeln" },
        candidates: matches.map((item) => ({ path: item.path, id: item.id })),
      }),
    ),
  });

const inventoryCommands = (locale?: string) => {
  const t = (text: CloudCliText) => localizeCloudCliText(locale, text);

  const resolveItem = async (ctx: CloudCliContext, raw: string): Promise<Item> => {
    const address = parseCliAddress(raw);
    if (address.kind === "local")
      throw new Error(t({ en: `"${raw}" is a local path, not an item.`, de: `„${raw}“ ist ein lokaler Pfad, kein Artikel.` }));
    const url =
      address.kind === "path"
        ? `/api/inventory/warehouses/${encodeURIComponent(address.container)}/resolve?${new URLSearchParams({ path: address.path })}`
        : `/api/inventory/items/${encodeURIComponent(address.ref)}`;
    return ctx.readJson<Item>(await ctx.fetch(url));
  };

  const itemArg = {
    item: arg.required({
      valueLabel: "item",
      description: t({ en: "Item ID or <warehouse>:<path>", de: "Artikel-ID oder <lager>:<pfad>" }),
    }),
  };

  return defineCliCommands({
    name: "inventory",
    summary: t({ en: "Manage inventory items.", de: "Lagerartikel verwalten." }),
    commands: [
      command("ls", {
        summary: t({ en: "List items in a warehouse", de: "Artikel eines Lagers auflisten" }),
        args: { warehouse: arg.required({ description: t({ en: "Warehouse ID or name", de: "Lager-ID oder -Name" }) }) },
        async run({ ctx, args }) {
          const page = await ctx.readJson<{ items: Item[] }>(
            await ctx.fetch(`/api/inventory/warehouses/${encodeURIComponent(args.warehouse)}/items`),
          );
          printRows(ctx, page, page.items, [
            { key: "id", label: "ID" },
            { key: "path", label: t({ en: "PATH", de: "PFAD" }) },
          ]);
        },
      }),
      command("rm", {
        summary: t({ en: "Delete an item", de: "Einen Artikel löschen" }),
        args: itemArg,
        flags: { yes: confirmFlag(t({ en: "Confirm the deletion", de: "Löschen bestätigen" })) },
        async run({ ctx, args, flags }) {
          if (!flags.yes) throw new Error(t({ en: "Deleting needs --yes.", de: "Löschen braucht --yes." }));
          const item = await resolveItem(ctx, args.item);
          await ctx.readJson<unknown>(await ctx.fetch(`/api/inventory/items/${encodeURIComponent(item.id)}`, { method: "DELETE" }));
          if (!printStructured(ctx, { deleted: { id: item.id, path: item.path } }))
            ctx.print(`${t({ en: "Deleted", de: "Gelöscht" })} ${item.path} (${item.id})`);
        },
      }),
    ],
  });
};

const inventory = inventoryCommands();

export default {
  ...inventory,
  help: (locale?: string) => inventoryCommands(locale).help!(),
  run: (ctx: CloudCliContext) => inventoryCommands(ctx.options.locale).run(ctx),
};
