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
} from "@k2b/cloud/cli";
import { z } from "zod";
import type { ApiType } from "./api";
import { downloadFile } from "./cli-download";
import { type AdminBrowseResult, AdoptInputSchema, type ArchivePage, type DownloadLease, type FileVersion, type SharePage, type ShareView } from "./contracts";

export function adminLifecycleCommands(locale?: string) {
  const t = (text: CloudCliText) => localizeCloudCliText(locale, text);
  const api = (ctx: CloudCliContext) => ctx.createApiClient<ApiType>("/api/filesv2");
  const area = flag.enum(["cloud", "freeipa"], { default: "cloud", description: t({ en: "Storage area", de: "Dateibereich" }) });
  const kind = flag.enum(["users", "groups"], { default: "users", description: t({ en: "Directory kind", de: "Verzeichnisart" }) });
  const after = flag.string({
    description: t({ en: "Unchanged next cursor from the previous page", de: "Unveränderter next-Cursor der vorherigen Seite" }),
  });
  const search = flag.string({ description: t({ en: "Filter names on the server", de: "Namen auf dem Server filtern" }) });
  const yes = confirmFlag(t({ en: "Confirm this operation", de: "Diese Aktion bestätigen" }));
  const confirmPath = flag.string({
    required: true,
    description: t({ en: "Exact root-relative path displayed by the API", de: "Exakter von der API angezeigter root-relativer Pfad" }),
  });
  const path = arg.required({
    description: t({ en: "Path relative to the selected directory", de: "Pfad relativ zum ausgewählten Verzeichnis" }),
  });
  const name = arg.required({
    description: t({ en: "Exact directory name from inventory", de: "Exakter Verzeichnisname aus dem Bestand" }),
  });
  const archive = arg.required({ description: t({ en: "Archive ID from archives list", de: "Archiv-ID aus archives list" }) });
  const locatorFlags = {
    area,
    kind,
    name: flag.string({ description: t({ en: "Directory name from inventory", de: "Verzeichnisname aus dem Bestand" }) }),
    archiveId: flag.string({
      description: t({ en: "Archive ID instead of a current directory", de: "Archiv-ID statt eines aktuellen Verzeichnisses" }),
    }),
  };
  const requireYes = (value: boolean) => {
    if (!value) throw new Error(t({ en: "This operation requires --yes.", de: "Diese Aktion erfordert --yes." }));
  };
  const confirmation = (value: string | undefined) => {
    if (!value)
      throw new Error(
        t({ en: "Pass the exact displayed path with --confirm-path.", de: "Gib den exakt angezeigten Pfad mit --confirm-path an." }),
      );
    return value;
  };
  const locator = (flags: { area?: "cloud" | "freeipa"; kind?: "users" | "groups"; name?: string; archiveId?: string }) => {
    if (Boolean(flags.name) === Boolean(flags.archiveId))
      throw new Error(t({ en: "Choose either --name or --archive-id.", de: "Wähle entweder --name oder --archive-id." }));
    return flags.archiveId
      ? { area: flags.area ?? "cloud", archiveId: flags.archiveId }
      : { area: flags.area ?? "cloud", kind: flags.kind ?? "users", name: flags.name };
  };
  const result = async (ctx: CloudCliContext, response: Parameters<CloudCliContext["readJson"]>[0], text: CloudCliText) => {
    const value = await ctx.readJson<unknown>(response);
    if (!printStructured(ctx, value)) ctx.print(`${t(text)}\n${JSON.stringify(value, null, 2)}`);
  };
  const next = (ctx: CloudCliContext, cursor: string | null) => {
    if (cursor && ctx.options.output === "text") ctx.error(`${t({ en: "Next page: --after", de: "Nächste Seite: --after" })} ${cursor}`);
  };
  return [
    command("admin shares list", {
      summary: t({ en: "List all public shares, including owners without file access", de: "Alle öffentlichen Freigaben anzeigen, auch nach Rechteverlust des Besitzers" }),
      flags: { after },
      async run({ ctx, flags }) {
        const page = await ctx.readJson<SharePage>(await api(ctx).admin.shares.$get({ query: { after: flags.after } }));
        printRows(ctx, ctx.options.output === "jsonl" ? page.items : page, page.items, [
          { key: "id", label: "ID" }, { key: "title", label: t({ en: "Name", de: "Name" }) }, { key: "createdBy", label: t({ en: "Owner", de: "Besitzer" }) }, { key: "state", label: "Status" },
        ]);
        if (page.next && ctx.options.output === "text") ctx.error(`--after ${page.next}`);
      },
    }),
    command("admin shares revoke", {
      summary: t({ en: "Revoke a public share as administrator", de: "Öffentliche Freigabe als Administrator sperren" }),
      args: { id: arg.required({ description: t({ en: "Share ID", de: "Freigabe-ID" }) }) },
      async run({ ctx, args }) {
        const share = await ctx.readJson<ShareView>(await api(ctx).admin.shares[":id"].revoke.$post({ param: { id: args.id } }));
        if (!printStructured(ctx, share)) ctx.print(`${share.title}: ${share.state}`);
      },
    }),
    command("admin uploads list", {
      summary: t({ en: "Inspect unresolved inbox reservations", de: "Ungeklärte Eingangsreservierungen prüfen" }),
      flags: { after },
      async run({ ctx, flags }) {
        const page = await ctx.readJson<{ items: { id: string; shareId: string | null; path: string; size: number; state: string; error: string | null; updatedAt: string }[]; next: string | null }>(await api(ctx).admin.uploads.$get({ query: { after: flags.after } }));
        printRows(ctx, ctx.options.output === "jsonl" ? page.items : page, page.items, [{ key: "id", label: "ID" }, { key: "path", label: t({ en: "Path", de: "Pfad" }) }, { key: "size", label: "Bytes" }, { key: "error", label: t({ en: "Reason", de: "Grund" }) }]);
        if (page.next && ctx.options.output === "text") ctx.error(`--after ${page.next}`);
      },
    }),
    command("admin versions list", {
      summary: t({ en: "List historical versions as administrator", de: "Historische Versionen als Administrator auflisten" }),
      args: { path }, flags: locatorFlags,
      async run({ ctx, args, flags }) {
        const rows = await ctx.readJson<FileVersion[]>(await api(ctx).admin.versions.$get({ query: { ...locator(flags), path: args.path } }));
        printRows(ctx, rows, rows, [{ key: "id", label: "ID" }, { key: "created", label: t({ en: "Created", de: "Erstellt" }) }, { key: "size", label: "Bytes" }]);
      },
    }),
    command("admin versions delete", {
      summary: t({ en: "Permanently delete a file version", de: "Eine Dateiversion endgültig löschen" }),
      args: { path, id: arg.required({ description: t({ en: "Version ID", de: "Versions-ID" }) }) },
      flags: { ...locatorFlags, yes, confirmPath },
      async run({ ctx, args, flags }) {
        requireYes(flags.yes);
        await result(ctx, await api(ctx).admin.versions.$delete({ json: { ...locator(flags), path: args.path, id: args.id, confirmPath: confirmation(flags.confirmPath) } }), { en: "Version deleted.", de: "Version gelöscht." });
      },
    }),
    command("admin operations retry", {
      summary: t({ en: "Retry a pending operation after fresh checks", de: "Ausstehende Aktion nach erneuter Prüfung fortsetzen" }),
      description: t({
        en: "May complete the original creation, archive, restoration or permanent deletion. The server checks current permissions, identity, configuration and source before continuing.",
        de: "Kann die ursprüngliche Erstellung, Archivierung, Wiederherstellung oder endgültige Löschung abschließen. Der Server prüft aktuelle Berechtigungen, Identität, Konfiguration und Quelle erneut.",
      }),
      args: {
        operation: arg.required({
          description: t({
            en: "Pending operation UUID from the result or inventory",
            de: "UUID der ausstehenden Aktion aus dem Ergebnis oder Bestand",
          }),
        }),
      },
      flags: { yes },
      async run({ ctx, args, flags }) {
        requireYes(flags.yes);
        const id = z.uuid().safeParse(args.operation);
        if (!id.success)
          throw new Error(
            t({
              en: "Use the pending operation UUID from the result or inventory.",
              de: "Verwende die UUID der ausstehenden Aktion aus dem Ergebnis oder Bestand.",
            }),
          );
        await result(ctx, await api(ctx).admin.operations[":id"].retry.$post({ param: { id: id.data } }), {
          en: "Operation retry result:",
          de: "Ergebnis der fortgesetzten Aktion:",
        });
      },
    }),
    command("admin directories create", {
      summary: t({ en: "Create a directory for an eligible identity", de: "Verzeichnis für eine berechtigte Identität erstellen" }),
      args: { identity: arg.required({ description: t({ en: "Identity UUID from inventory", de: "Identitäts-UUID aus dem Bestand" }) }) },
      flags: { area, kind, yes },
      async run({ ctx, args, flags }) {
        requireYes(flags.yes);
        const parsed = AdoptInputSchema.safeParse({ area: flags.area, kind: flags.kind, identityId: args.identity });
        if (!parsed.success)
          throw new Error(
            t({ en: "Use the identity UUID from admin inventory.", de: "Verwende die Identitäts-UUID aus admin inventory." }),
          );
        await result(ctx, await api(ctx).admin.directories.create.$post({ json: parsed.data }), {
          en: "Directory creation result:",
          de: "Ergebnis der Verzeichniserstellung:",
        });
      },
    }),
    command("admin directories archive", {
      summary: t({ en: "Move a directory into the archive", de: "Verzeichnis ins Archiv verschieben" }),
      args: { name },
      flags: {
        area,
        kind,
        yes,
        archivePath: flag.string({
          description: t({ en: "Archive path relative to the area's prefix", de: "Archivpfad relativ zum Bereichsprefix" }),
        }),
      },
      async run({ ctx, args, flags }) {
        requireYes(flags.yes);
        await result(
          ctx,
          await api(ctx).admin.directories.archive.$post({
            json: { area: flags.area ?? "cloud", kind: flags.kind ?? "users", name: args.name, archivePath: flags.archivePath },
          }),
          { en: "Archival result:", de: "Archivierungsergebnis:" },
        );
      },
    }),
    command("admin directories retire", {
      summary: t({ en: "Retire a directory from active use", de: "Verzeichnis außer Betrieb nehmen" }),
      args: { name },
      flags: { area, kind, yes },
      async run({ ctx, args, flags }) {
        requireYes(flags.yes);
        await result(
          ctx,
          await api(ctx).admin.directories.retire.$post({
            json: { area: flags.area ?? "cloud", kind: flags.kind ?? "users", name: args.name },
          }),
          { en: "Retirement result:", de: "Ergebnis der Stilllegung:" },
        );
      },
    }),
    command("admin directories delete", {
      summary: t({ en: "Permanently delete an entire directory", de: "Ein ganzes Verzeichnis endgültig löschen" }),
      args: { name },
      flags: { area, kind, yes, confirmPath },
      async run({ ctx, args, flags }) {
        requireYes(flags.yes);
        await result(
          ctx,
          await api(ctx).admin.directories.delete.$post({
            json: {
              area: flags.area ?? "cloud",
              kind: flags.kind ?? "users",
              name: args.name,
              confirmPath: confirmation(flags.confirmPath),
            },
          }),
          { en: "Deletion result:", de: "Löschergebnis:" },
        );
      },
    }),
    command("admin archives list", {
      summary: t({ en: "List a page of archived directories", de: "Eine Seite archivierter Verzeichnisse auflisten" }),
      flags: { area, search, after },
      async run({ ctx, flags }) {
        const value = await ctx.readJson<ArchivePage>(
          await api(ctx).admin.archives.$get({ query: { area: flags.area ?? "cloud", q: flags.search, after: flags.after } }),
        );
        printRows(ctx, ctx.options.output === "jsonl" ? value.items : value, value.items, [
          { key: "id", label: "ID" },
          { key: "name", label: "Name" },
          { key: "path", label: t({ en: "Path", de: "Pfad" }) },
          { key: "originalPath", label: t({ en: "Original path", de: "Ursprünglicher Pfad" }) },
          { key: "state", label: "Status" },
        ]);
        next(ctx, value.next);
      },
    }),
    command("admin archives restore", {
      summary: t({
        en: "Restore an archived directory to its original path",
        de: "Archiviertes Verzeichnis am ursprünglichen Pfad wiederherstellen",
      }),
      args: { archive },
      flags: { yes, confirmPath },
      async run({ ctx, args, flags }) {
        requireYes(flags.yes);
        await result(
          ctx,
          await api(ctx).admin.archives[":id"].restore.$post({
            param: { id: args.archive },
            json: { confirmPath: confirmation(flags.confirmPath) },
          }),
          { en: "Restoration result:", de: "Wiederherstellungsergebnis:" },
        );
      },
    }),
    command("admin archives delete", {
      summary: t({ en: "Permanently delete an archived directory", de: "Archiviertes Verzeichnis endgültig löschen" }),
      args: { archive },
      flags: { yes, confirmPath },
      async run({ ctx, args, flags }) {
        requireYes(flags.yes);
        await result(
          ctx,
          await api(ctx).admin.archives[":id"].$delete({
            param: { id: args.archive },
            json: { confirmPath: confirmation(flags.confirmPath) },
          }),
          { en: "Archive deletion result:", de: "Ergebnis der Archivlöschung:" },
        );
      },
    }),
    command("admin files list", {
      summary: t({
        en: "Browse a current or archived directory as administrator",
        de: "Aktuelles oder archiviertes Verzeichnis als Administrator durchsuchen",
      }),
      flags: {
        ...locatorFlags,
        path: flag.string({ default: "", description: t({ en: "Relative directory path", de: "Relativer Verzeichnispfad" }) }),
        after,
      },
      async run({ ctx, flags }) {
        const value = await ctx.readJson<AdminBrowseResult>(
          await api(ctx).admin.entries.$get({ query: { ...locator(flags), path: flags.path, after: flags.after } }),
        );
        printRows(ctx, ctx.options.output === "jsonl" ? value.items : value, value.items, [
          { key: "path", label: t({ en: "Path", de: "Pfad" }) },
          { key: "directory", label: t({ en: "Directory", de: "Verzeichnis" }) },
          { key: "size", label: "Bytes" },
        ]);
        if (ctx.options.output === "text") ctx.print(`${t({ en: "Base path", de: "Basispfad" })}: ${value.basePath}`);
        next(ctx, value.next);
      },
    }),
    command("admin files download", {
      summary: t({ en: "Download a current or archived file directly", de: "Aktuelle oder archivierte Datei direkt herunterladen" }),
      args: { path },
      flags: {
        ...locatorFlags,
        out: flag.string({
          required: true,
          description: t({ en: "New output file; never overwrite", de: "Neue Zieldatei; kein Überschreiben" }),
        }),
      },
      async run({ ctx, args, flags }) {
        const source = locator(flags);
        if (!flags.out) throw new Error(t({ en: "Pass --out with a new file path.", de: "Gib mit --out einen neuen Dateipfad an." }));
        const value = await downloadFile(ctx, flags.out, async (signal) =>
          ctx.readJson<DownloadLease>(await api(ctx).admin.download.$post({ json: { ...source, path: args.path } }, { init: { signal } })),
        );
        if (!printStructured(ctx, value)) ctx.print(`${t({ en: "Saved", de: "Gespeichert" })}: ${value.path} (${value.bytes} bytes)`);
      },
    }),
    command("admin files delete", {
      summary: t({ en: "Permanently delete a selected file or folder", de: "Ausgewählte Datei oder Ordner endgültig löschen" }),
      args: { path },
      flags: { ...locatorFlags, yes, confirmPath },
      async run({ ctx, args, flags }) {
        requireYes(flags.yes);
        await result(
          ctx,
          await api(ctx).admin.entries.$delete({
            json: { ...locator(flags), path: args.path, confirmPath: confirmation(flags.confirmPath) },
          }),
          { en: "Deletion result:", de: "Löschergebnis:" },
        );
      },
    }),
    command("admin root refresh", {
      summary: t({ en: "Refresh the root's statistics", de: "Statistiken des Roots aktualisieren" }),
      flags: { area },
      async run({ ctx, flags }) {
        await result(ctx, await api(ctx).admin.root.refresh.$post({ json: { area: flags.area ?? "cloud" } }), {
          en: "Root statistics:",
          de: "Root-Statistiken:",
        });
      },
    }),
    command("admin root rebuild", {
      summary: t({ en: "Rebuild the entire root's index", de: "Index des gesamten Roots neu aufbauen" }),
      description: t({
        en: "A configured area prefix does not limit the rebuild: it affects the entire Filegate root.",
        de: "Ein konfigurierter Bereichsprefix begrenzt den Neuaufbau nicht: Er betrifft den gesamten Filegate-Root.",
      }),
      flags: { area, yes },
      async run({ ctx, flags }) {
        requireYes(flags.yes);
        await result(ctx, await api(ctx).admin.root.rebuild.$post({ json: { area: flags.area ?? "cloud" } }), {
          en: "Root index rebuild result:",
          de: "Ergebnis des Root-Index-Neuaufbaus:",
        });
      },
    }),
  ];
}
