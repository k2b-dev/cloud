import {
  arg,
  type CloudCliContext,
  type CloudCliText,
  command,
  confirmFlag,
  flag,
  localizeCloudCliText,
  printRows,
  printStructured,
  readCliInput,
} from "@k2b/cloud/cli";
import type { ApiType } from "./api";
import type { EntryResult } from "./contracts";
import { TEMPLATE_LIMIT } from "./document-assets";
import { type FileTemplate, TemplateGrantSchema, TemplateMetadataSchema, type TemplatePage } from "./template-contracts";
export function templateCommands(locale?: string) {
  const t = (text: CloudCliText) => localizeCloudCliText(locale, text);
  const api = (ctx: CloudCliContext) => ctx.createApiClient<ApiType>("/api/filesv2").templates;
  const id = { id: arg.required({ description: t({ en: "Template ID", de: "Vorlagen-ID" }) }) };
  const metadata = {
    name: flag.string({ required: true, description: t({ en: "Template name", de: "Vorlagenname" }) }),
    description: flag.string({ default: "", description: t({ en: "Description", de: "Beschreibung" }) }),
  };
  const output = (ctx: CloudCliContext, value: unknown) => {
    if (!printStructured(ctx, value)) ctx.print(JSON.stringify(value, null, 2));
  };
  const file = async (path: string) => {
    const blob = Bun.file(path);
    if (blob.size > TEMPLATE_LIMIT)
      throw new Error(t({ en: "Templates support files up to 20 MiB.", de: "Vorlagen unterstützen Dateien bis 20 MiB." }));
    return { filename: path.split(/[\\/]/).at(-1)!, content: Buffer.from(await blob.arrayBuffer()).toString("base64") };
  };
  return [
    ...[false, true].map((administrative) =>
      command(administrative ? "admin templates list" : "templates list", {
        summary: t({
          en: administrative ? "List all templates" : "List usable templates",
          de: administrative ? "Alle Vorlagen auflisten" : "Nutzbare Vorlagen auflisten",
        }),
        flags: {
          search: flag.string({ default: "", description: t({ en: "Name filter", de: "Namensfilter" }) }),
          after: flag.string({ description: t({ en: "Next-page cursor", de: "Cursor der nächsten Seite" }) }),
        },
        async run({ ctx, flags }) {
          const query = { q: flags.search, after: flags.after };
          const result = await ctx.readJson<TemplatePage>(
            await (administrative ? api(ctx).admin.$get({ query }) : api(ctx).$get({ query })),
          );
          printRows(ctx, ctx.options.output === "jsonl" ? result.items : result, result.items, [
            { key: "id", label: "ID" },
            { key: "name", label: t({ en: "Name", de: "Name" }) },
            { key: "filename", label: t({ en: "File", de: "Datei" }) },
            { key: "size", label: "Bytes" },
          ]);
          if (result.next && ctx.options.output === "text") ctx.error(`--after ${result.next}`);
        },
      }),
    ),
    command("templates get", {
      summary: t({ en: "Read template metadata", de: "Vorlageninformationen lesen" }),
      args: id,
      async run({ ctx, args }) {
        output(ctx, await ctx.readJson<FileTemplate>(await api(ctx)[":id"].$get({ param: args })));
      },
    }),
    command("templates use", {
      summary: t({ en: "Create an independent file from a template", de: "Unabhängige Datei aus Vorlage erstellen" }),
      args: {
        ...id,
        base: arg.required({ description: t({ en: "Destination base ID", de: "Zielablagen-ID" }) }),
        path: arg.required({ description: t({ en: "New file path", de: "Neuer Dateipfad" }) }),
      },
      async run({ ctx, args }) {
        output(
          ctx,
          await ctx.readJson<EntryResult>(
            await api(ctx)[":id"].use.$post({ param: { id: args.id }, json: { baseId: args.base, path: args.path } }),
          ),
        );
      },
    }),
    command("admin templates upload", {
      summary: t({ en: "Upload a template snapshot", de: "Vorlagenkopie hochladen" }),
      args: { file: arg.required({ description: t({ en: "Local file", de: "Lokale Datei" }) }) },
      flags: metadata,
      async run({ ctx, args, flags }) {
        output(
          ctx,
          await ctx.readJson<FileTemplate>(
            await api(ctx).admin.$post({ json: { ...(await file(args.file)), ...TemplateMetadataSchema.parse(flags) } }),
          ),
        );
      },
    }),
    command("admin templates import", {
      summary: t({ en: "Copy an accessible file into the template catalog", de: "Zugängliche Datei in den Vorlagenkatalog kopieren" }),
      args: {
        base: arg.required({ description: t({ en: "Source base ID", de: "Quellablagen-ID" }) }),
        path: arg.required({ description: t({ en: "Source path", de: "Quellpfad" }) }),
      },
      flags: metadata,
      async run({ ctx, args, flags }) {
        output(
          ctx,
          await ctx.readJson<FileTemplate>(
            await api(ctx).admin.import.$post({
              json: { ...TemplateMetadataSchema.parse(flags), source: { baseId: args.base, path: args.path } },
            }),
          ),
        );
      },
    }),
    command("admin templates update", {
      summary: t({ en: "Update template metadata", de: "Vorlageninformationen ändern" }),
      args: id,
      flags: {
        ...metadata,
        file: flag.string({
          description: t({ en: "Replace snapshot in the same update", de: "Vorlageninhalt mit derselben Änderung ersetzen" }),
        }),
      },
      async run({ ctx, args, flags }) {
        output(
          ctx,
          await ctx.readJson<FileTemplate>(
            await api(ctx).admin[":id"].$patch({
              param: args,
              json: { ...TemplateMetadataSchema.parse(flags), file: flags.file ? await file(flags.file) : undefined },
            }),
          ),
        );
      },
    }),
    command("admin templates replace", {
      summary: t({ en: "Replace a template with a new snapshot", de: "Vorlageninhalt durch neue Kopie ersetzen" }),
      args: { ...id, file: arg.required({ description: t({ en: "Local replacement file", de: "Lokale Ersatzdatei" }) }) },
      async run({ ctx, args }) {
        output(
          ctx,
          await ctx.readJson<FileTemplate>(
            await api(ctx).admin[":id"].content.$put({ param: { id: args.id }, json: await file(args.file) }),
          ),
        );
      },
    }),
    command("admin templates delete", {
      summary: t({ en: "Delete a template; created files stay unchanged", de: "Vorlage löschen; erzeugte Dateien bleiben unverändert" }),
      args: id,
      flags: { yes: confirmFlag(t({ en: "Confirm deletion", de: "Löschen bestätigen" })) },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error(t({ en: "Requires --yes.", de: "Erfordert --yes." }));
        output(ctx, await ctx.readJson(await api(ctx).admin[":id"].$delete({ param: args })));
      },
    }),
    command("admin templates access list", {
      summary: t({ en: "Read template grants", de: "Vorlagenrechte lesen" }),
      args: id,
      async run({ ctx, args }) {
        output(ctx, await ctx.readJson(await api(ctx).admin[":id"].grants.$get({ param: args })));
      },
    }),
    command("admin templates access grant", {
      summary: t({ en: "Grant template use to a Cloud principal", de: "Cloud-Nutzer oder Gruppe zur Vorlagennutzung berechtigen" }),
      args: id,
      flags: {
        input: flag.input({ required: true, description: t({ en: "JSON or @file with principal", de: "JSON oder @Datei mit principal" }) }),
      },
      async run({ ctx, args, flags }) {
        const input = TemplateGrantSchema.parse(JSON.parse((await readCliInput(flags.input, { required: true })) ?? ""));
        output(ctx, await ctx.readJson(await api(ctx).admin[":id"].grants.$post({ param: args, json: input })));
      },
    }),
    command("admin templates access revoke", {
      summary: t({ en: "Revoke template use", de: "Vorlagennutzung entziehen" }),
      args: { ...id, accessId: arg.required({ description: t({ en: "Access entry ID", de: "ID der Zugriffsregel" }) }) },
      async run({ ctx, args }) {
        output(ctx, await ctx.readJson(await api(ctx).admin[":id"].grants[":accessId"].$delete({ param: args })));
      },
    }),
    command("documents markdown", {
      summary: t({ en: "Create an empty Markdown document", de: "Leeres Markdown-Dokument erstellen" }),
      args: {
        base: arg.required({ description: t({ en: "Base ID", de: "Ablagen-ID" }) }),
        path: arg.required({ description: t({ en: "New .md path", de: "Neuer .md-Pfad" }) }),
      },
      async run({ ctx, args }) {
        const client = ctx.createApiClient<ApiType>("/api/filesv2");
        output(
          ctx,
          await ctx.readJson<EntryResult>(
            await client.bases[":baseId"].markdown.$post({ param: { baseId: args.base }, json: { path: args.path } }),
          ),
        );
      },
    }),
  ];
}
