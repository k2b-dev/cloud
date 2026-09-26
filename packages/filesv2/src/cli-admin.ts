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
import { z } from "zod";
import type { ApiType } from "./api";
import { CliAddressError, parseAdminAddress } from "./cli-address";
import { downloadFile } from "./cli-download";
import {
  type AdminBrowseResult,
  type AdminResult,
  AdoptInputSchema,
  type ArchivePage,
  ConfigurationInputSchema,
  type DownloadLease,
  type FileVersion,
  type InventoryState,
  InventoryStateSchema,
  type SharePage,
  type ShareView,
} from "./contracts";

export function adminCommands(locale?: string) {
  const t = (text: CloudCliText) => localizeCloudCliText(locale, text);
  const api = (ctx: CloudCliContext) => ctx.createApiClient<ApiType>("/api/filesv2");
  const storage = flag.enum(["cloud", "freeipa"], {
    default: "cloud",
    description: t({ en: "Storage: cloud or freeipa", de: "Ablage: cloud oder freeipa" }),
  });
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
  const directoryText = t({
    en: "<storage>/<users|groups>/<name> or <storage>/archive/<archive-id>",
    de: "<ablage>/<users|groups>/<name> oder <ablage>/archive/<archiv-id>",
  });
  const directory = arg.required({ valueLabel: "directory", description: directoryText });
  const entry = arg.required({
    valueLabel: "file",
    description: t({ en: `${directoryText}, then :/path`, de: `${directoryText}, dann :/pfad` }),
  });
  const archive = arg.required({ description: t({ en: "Archive ID from archives list", de: "Archiv-ID aus archives list" }) });
  const requireYes = (value: boolean) => {
    if (!value) throw new Error(t({ en: "This operation requires --yes.", de: "Diese Aktion erfordert --yes." }));
  };
  const address = (raw: string) => {
    try {
      return parseAdminAddress(raw);
    } catch (error) {
      if (error instanceof CliAddressError) throw new Error(t(error.text));
      throw error;
    }
  };
  /** A current directory; archive addresses have no lifecycle of their own. */
  const currentDirectory = (raw: string) => {
    const { locator } = address(raw);
    if (!("name" in locator))
      throw new Error(t({ en: "Name a current directory, not an archive.", de: "Gib ein aktuelles Verzeichnis an, kein Archiv." }));
    return locator;
  };
  const confirmation = (value: string | undefined) => {
    if (!value)
      throw new Error(
        t({ en: "Pass the exact displayed path with --confirm-path.", de: "Gib den exakt angezeigten Pfad mit --confirm-path an." }),
      );
    return value;
  };
  const result = async (ctx: CloudCliContext, response: Parameters<CloudCliContext["readJson"]>[0], text: CloudCliText) => {
    const value = await ctx.readJson<unknown>(response);
    if (!printStructured(ctx, value)) ctx.print(`${t(text)}\n${JSON.stringify(value, null, 2)}`);
  };
  const next = (ctx: CloudCliContext, cursor: string | null) => {
    if (cursor && ctx.options.output === "text") ctx.error(`${t({ en: "Next page: --after", de: "Nächste Seite: --after" })} ${cursor}`);
  };
  const admin = async (
    ctx: CloudCliContext,
    query: {
      area?: "cloud" | "freeipa";
      kind?: "users" | "groups";
      after?: string;
      q?: string;
      status?: InventoryState;
      includeEntries?: "false";
    } = {},
  ) => ctx.readJson<AdminResult>(await api(ctx).admin.$get({ query }));
  const identity = (ctx: { storage?: "cloud" | "freeipa"; kind?: "users" | "groups" }, id: string) => {
    const parsed = AdoptInputSchema.safeParse({ area: ctx.storage, kind: ctx.kind, identityId: id });
    if (!parsed.success)
      throw new Error(t({ en: "Use the identity UUID from admin inventory.", de: "Verwende die Identitäts-UUID aus admin inventory." }));
    return parsed.data;
  };
  return [
    command("admin inventory", {
      summary: t({ en: "Inspect filesystem inventory and root statistics", de: "Dateisystembestand und Root-Statistiken prüfen" }),
      flags: {
        storage,
        kind,
        after,
        search,
        status: flag.enum(InventoryStateSchema.options, {
          description: t({ en: "Filter inventory status", de: "Bestandsstatus filtern" }),
        }),
      },
      async run({ ctx, flags }) {
        const value = await admin(ctx, {
          area: flags.storage,
          kind: flags.kind,
          after: flags.after,
          q: flags.search,
          status: flags.status,
        });
        if (value.issue) ctx.error(`${t({ en: "Storage status", de: "Ablagenstatus" })}: ${value.issue}`);
        printRows(ctx, ctx.options.output === "jsonl" ? value.items : value, value.items, [
          { key: "identityId", label: "ID" },
          { key: "name", label: "Name" },
          {
            key: "displayName",
            label: t({ en: "Display name", de: "Anzeigename" }),
            value: (item) =>
              item.displayName ??
              (item.kind === "users"
                ? t({ en: "unknown account", de: "unbekanntes Konto" })
                : t({ en: "unknown group", de: "unbekannte Gruppe" })),
          },
          { key: "path", label: t({ en: "Path", de: "Pfad" }) },
          { key: "status", label: "Status" },
          { key: "reason", label: t({ en: "Reason", de: "Grund" }) },
          { key: "uid", label: "UID" },
          { key: "gid", label: "GID" },
          {
            key: "actions",
            label: t({ en: "Actions", de: "Aktionen" }),
            value: (item) =>
              Object.entries(item.actions)
                .filter(([, enabled]) => enabled)
                .map(([action]) => action)
                .join(", "),
          },
        ]);
        if (ctx.options.output === "text") {
          const unknown = t({ en: "unknown", de: "unbekannt" });
          ctx.print(
            `Root: ${value.root?.name ?? unknown}; ${t({ en: "files", de: "Dateien" })}: ${value.root?.files ?? unknown}; bytes: ${value.root?.bytes ?? unknown}`,
          );
        }
        next(ctx, value.next);
      },
    }),
    command("admin configuration get", {
      summary: t({ en: "Read configuration without the backend token", de: "Konfiguration ohne Backend-Token lesen" }),
      async run({ ctx }) {
        const value = await admin(ctx, { includeEntries: "false" });
        if (!printStructured(ctx, value.configuration)) ctx.print(JSON.stringify(value.configuration, null, 2));
      },
    }),
    command("admin configuration set", {
      summary: t({ en: "Replace configuration from a JSON file or stdin", de: "Konfiguration aus JSON-Datei oder stdin ersetzen" }),
      description: t({
        en: "Omit token or leave it empty to retain the saved token. Use --input-file or --stdin to keep secrets out of arguments.",
        de: "Ohne token oder bei leerem token bleibt der gespeicherte Token erhalten. Verwende --input-file oder --stdin, damit Secrets nicht in Argumenten stehen.",
      }),
      flags: {
        input: flag.input({
          required: true,
          description: t({ en: "Configuration JSON (file or stdin only)", de: "Konfigurations-JSON (nur Datei oder stdin)" }),
        }),
      },
      examples: ["cld filesv2 admin configuration set --input-file ./filesv2.json"],
      async run({ ctx, flags }) {
        if (flags.input.source === "value")
          throw new Error(
            t({ en: "Use --input-file or --stdin for configuration.", de: "Verwende --input-file oder --stdin für die Konfiguration." }),
          );
        const raw = await readCliInput(flags.input, { required: true });
        let value: unknown;
        try {
          value = JSON.parse(raw ?? "");
        } catch {
          throw new Error(t({ en: "Configuration must be valid JSON.", de: "Die Konfiguration muss gültiges JSON enthalten." }));
        }
        const parsed = ConfigurationInputSchema.safeParse(value);
        if (!parsed.success)
          throw new Error(
            `${t({ en: "Invalid configuration fields", de: "Ungültige Konfigurationsfelder" })}: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
          );
        const saved = await ctx.readJson<{ saved: boolean }>(await api(ctx).admin.configuration.$put({ json: parsed.data }));
        if (!printStructured(ctx, saved)) ctx.print(t({ en: "Configuration saved.", de: "Konfiguration gespeichert." }));
      },
    }),
    command("admin adopt", {
      summary: t({
        en: "Assign an existing directory to its current identity",
        de: "Bestehendes Verzeichnis seiner aktuellen Identität zuordnen",
      }),
      args: {
        identity: arg.required({ description: t({ en: "Identity UUID from admin inventory", de: "Identitäts-UUID aus admin inventory" }) }),
      },
      flags: { storage, kind, yes: confirmFlag(t({ en: "Confirm assigning the directory", de: "Verzeichniszuordnung bestätigen" })) },
      async run({ ctx, args, flags }) {
        if (!flags.yes)
          throw new Error(t({ en: "Assigning a directory requires --yes.", de: "Die Verzeichniszuordnung erfordert --yes." }));
        const value = await ctx.readJson<unknown>(await api(ctx).admin.adopt.$post({ json: identity(flags, args.identity) }));
        if (!printStructured(ctx, value)) ctx.print(t({ en: "Directory assigned.", de: "Verzeichnis zugeordnet." }));
      },
    }),
    command("admin shares list", {
      summary: t({
        en: "List all public links, including owners without file access",
        de: "Alle öffentlichen Links anzeigen, auch nach Rechteverlust des Besitzers",
      }),
      flags: { after },
      async run({ ctx, flags }) {
        const page = await ctx.readJson<SharePage>(await api(ctx).admin.shares.$get({ query: { after: flags.after } }));
        printRows(ctx, ctx.options.output === "jsonl" ? page.items : page, page.items, [
          { key: "id", label: "ID" },
          { key: "title", label: t({ en: "Name", de: "Name" }) },
          { key: "createdBy", label: t({ en: "Owner", de: "Besitzer" }) },
          { key: "state", label: "Status" },
        ]);
        next(ctx, page.next);
      },
    }),
    command("admin shares revoke", {
      summary: t({ en: "Revoke any public link as administrator", de: "Einen öffentlichen Link als Administrator widerrufen" }),
      args: { id: arg.required({ description: t({ en: "Share ID", de: "Freigabe-ID" }) }) },
      flags: { yes },
      async run({ ctx, args, flags }) {
        requireYes(flags.yes);
        const share = await ctx.readJson<ShareView>(await api(ctx).admin.shares[":id"].revoke.$post({ param: { id: args.id } }));
        if (!printStructured(ctx, share)) ctx.print(`${share.title}: ${share.state}`);
      },
    }),
    command("admin uploads list", {
      summary: t({ en: "Inspect unresolved inbox reservations", de: "Ungeklärte Eingangsreservierungen prüfen" }),
      flags: { after },
      async run({ ctx, flags }) {
        const page = await ctx.readJson<{
          items: {
            id: string;
            shareId: string | null;
            path: string;
            size: number;
            state: string;
            error: string | null;
            updatedAt: string;
          }[];
          next: string | null;
        }>(await api(ctx).admin.uploads.$get({ query: { after: flags.after } }));
        printRows(ctx, ctx.options.output === "jsonl" ? page.items : page, page.items, [
          { key: "id", label: "ID" },
          { key: "path", label: t({ en: "Path", de: "Pfad" }) },
          { key: "size", label: "Bytes" },
          { key: "error", label: t({ en: "Reason", de: "Grund" }) },
        ]);
        next(ctx, page.next);
      },
    }),
    command("admin versions list", {
      summary: t({ en: "List a file's versions as administrator", de: "Die Versionen einer Datei als Administrator auflisten" }),
      args: { file: entry },
      examples: ["cld filesv2 admin versions list cloud/groups/team:/Documents/report.pdf"],
      async run({ ctx, args }) {
        const { locator, path } = address(args.file);
        const rows = await ctx.readJson<FileVersion[]>(await api(ctx).admin.versions.$get({ query: { ...locator, path } }));
        printRows(ctx, rows, rows, [
          { key: "id", label: "ID" },
          { key: "created", label: t({ en: "Created", de: "Erstellt" }) },
          { key: "size", label: "Bytes" },
        ]);
      },
    }),
    command("admin versions delete", {
      summary: t({ en: "Permanently delete a file version", de: "Eine Dateiversion endgültig löschen" }),
      args: { file: entry, id: arg.required({ valueLabel: "version", description: t({ en: "Version ID", de: "Versions-ID" }) }) },
      flags: { yes, confirmPath },
      async run({ ctx, args, flags }) {
        requireYes(flags.yes);
        const { locator, path } = address(args.file);
        await result(
          ctx,
          await api(ctx).admin.versions.$delete({ json: { ...locator, path, id: args.id, confirmPath: confirmation(flags.confirmPath) } }),
          { en: "Version deleted.", de: "Version gelöscht." },
        );
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
      flags: { storage, kind, yes },
      async run({ ctx, args, flags }) {
        requireYes(flags.yes);
        await result(ctx, await api(ctx).admin.directories.create.$post({ json: identity(flags, args.identity) }), {
          en: "Directory creation result:",
          de: "Ergebnis der Verzeichniserstellung:",
        });
      },
    }),
    command("admin directories archive", {
      summary: t({ en: "Move a directory into the archive", de: "Verzeichnis ins Archiv verschieben" }),
      args: { directory },
      flags: {
        yes,
        archivePath: flag.string({
          description: t({ en: "Archive path relative to the storage prefix", de: "Archivpfad relativ zum Ablagenprefix" }),
        }),
      },
      examples: ["cld filesv2 admin directories archive freeipa/groups/alumni --yes"],
      async run({ ctx, args, flags }) {
        requireYes(flags.yes);
        await result(
          ctx,
          await api(ctx).admin.directories.archive.$post({ json: { ...currentDirectory(args.directory), archivePath: flags.archivePath } }),
          {
            en: "Archival result:",
            de: "Archivierungsergebnis:",
          },
        );
      },
    }),
    command("admin directories retire", {
      summary: t({ en: "Retire a directory from active use", de: "Verzeichnis außer Betrieb nehmen" }),
      args: { directory },
      flags: { yes },
      async run({ ctx, args, flags }) {
        requireYes(flags.yes);
        await result(ctx, await api(ctx).admin.directories.retire.$post({ json: currentDirectory(args.directory) }), {
          en: "Retirement result:",
          de: "Ergebnis der Stilllegung:",
        });
      },
    }),
    command("admin directories delete", {
      summary: t({ en: "Permanently delete an entire directory", de: "Ein ganzes Verzeichnis endgültig löschen" }),
      args: { directory },
      flags: { yes, confirmPath },
      async run({ ctx, args, flags }) {
        requireYes(flags.yes);
        await result(
          ctx,
          await api(ctx).admin.directories.delete.$post({
            json: { ...currentDirectory(args.directory), confirmPath: confirmation(flags.confirmPath) },
          }),
          { en: "Deletion result:", de: "Löschergebnis:" },
        );
      },
    }),
    command("admin archives list", {
      summary: t({ en: "List a page of archived directories", de: "Eine Seite archivierter Verzeichnisse auflisten" }),
      flags: { storage, search, after },
      async run({ ctx, flags }) {
        const value = await ctx.readJson<ArchivePage>(
          await api(ctx).admin.archives.$get({ query: { area: flags.storage ?? "cloud", q: flags.search, after: flags.after } }),
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
    command("admin files ls", {
      summary: t({
        en: "Browse a current or archived directory as administrator",
        de: "Aktuelles oder archiviertes Verzeichnis als Administrator durchsuchen",
      }),
      description: t({
        en: "Unlike ls, shows the reserved trash folder.",
        de: "Anders als ls zeigt der Befehl auch den reservierten Papierkorbordner.",
      }),
      args: {
        folder: arg.required({
          valueLabel: "folder",
          description: t({ en: `${directoryText}, optionally :/path`, de: `${directoryText}, optional :/pfad` }),
        }),
      },
      flags: { after },
      examples: ["cld filesv2 admin files ls cloud/groups/team:/trash", "cld filesv2 admin files ls freeipa/archive/<archive-id>"],
      async run({ ctx, args, flags }) {
        const { locator, path } = address(args.folder);
        const value = await ctx.readJson<AdminBrowseResult>(
          await api(ctx).admin.entries.$get({ query: { ...locator, path, after: flags.after } }),
        );
        printRows(ctx, ctx.options.output === "jsonl" ? value.items : value, value.items, [
          { key: "path", label: t({ en: "Path", de: "Pfad" }), value: (item) => `${item.path}${item.directory ? "/" : ""}` },
          { key: "size", label: "Bytes", value: (item) => (item.directory ? "" : item.size) },
        ]);
        if (ctx.options.output === "text") ctx.print(`${t({ en: "Base path", de: "Basispfad" })}: ${value.basePath}`);
        next(ctx, value.next);
      },
    }),
    command("admin files get", {
      summary: t({ en: "Download a current or archived file directly", de: "Aktuelle oder archivierte Datei direkt herunterladen" }),
      args: {
        file: entry,
        local: arg.required({
          valueLabel: "local",
          description: t({ en: "New local file; never overwritten", de: "Neue lokale Datei; wird nie überschrieben" }),
        }),
      },
      async run({ ctx, args }) {
        const { locator, path } = address(args.file);
        const value = await downloadFile(ctx, args.local, async (signal) =>
          ctx.readJson<DownloadLease>(await api(ctx).admin.download.$post({ json: { ...locator, path } }, { init: { signal } })),
        );
        if (!printStructured(ctx, value)) ctx.print(`${t({ en: "Saved", de: "Gespeichert" })}: ${value.path} (${value.bytes} bytes)`);
      },
    }),
    command("admin files rm", {
      summary: t({ en: "Permanently delete a file or folder", de: "Eine Datei oder einen Ordner endgültig löschen" }),
      description: t({
        en: "Bypasses the trash. Pass the exact root-relative path with --confirm-path.",
        de: "Umgeht den Papierkorb. Gib den exakten root-relativen Pfad mit --confirm-path an.",
      }),
      args: { file: entry },
      flags: { yes, confirmPath },
      async run({ ctx, args, flags }) {
        requireYes(flags.yes);
        const { locator, path } = address(args.file);
        await result(
          ctx,
          await api(ctx).admin.entries.$delete({ json: { ...locator, path, confirmPath: confirmation(flags.confirmPath) } }),
          {
            en: "Deletion result:",
            de: "Löschergebnis:",
          },
        );
      },
    }),
    command("admin root refresh", {
      summary: t({ en: "Refresh the root's statistics", de: "Statistiken des Roots aktualisieren" }),
      flags: { storage },
      async run({ ctx, flags }) {
        await result(ctx, await api(ctx).admin.root.refresh.$post({ json: { area: flags.storage ?? "cloud" } }), {
          en: "Root statistics:",
          de: "Root-Statistiken:",
        });
      },
    }),
    command("admin root rebuild", {
      summary: t({ en: "Rebuild the entire root's index", de: "Index des gesamten Roots neu aufbauen" }),
      description: t({
        en: "A configured storage prefix does not limit the rebuild: it affects the entire Filegate root.",
        de: "Ein konfigurierter Ablagenprefix begrenzt den Neuaufbau nicht: Er betrifft den gesamten Filegate-Root.",
      }),
      flags: { storage, yes },
      async run({ ctx, flags }) {
        requireYes(flags.yes);
        await result(ctx, await api(ctx).admin.root.rebuild.$post({ json: { area: flags.storage ?? "cloud" } }), {
          en: "Root index rebuild result:",
          de: "Ergebnis des Root-Index-Neuaufbaus:",
        });
      },
    }),
  ];
}
