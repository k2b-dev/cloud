import {
  arg,
  type CloudCliContext,
  type CloudCliText,
  command,
  confirmFlag,
  defineCliCommands,
  flag,
  localizeCloudCliText,
  printRows,
  printStructured,
  readCliInput,
} from "@k2b/cloud/cli";
import type { ApiType } from "./api";
import { adminLifecycleCommands } from "./cli-admin";
import { downloadFile } from "./cli-download";
import {
  type AdminResult,
  AdoptInputSchema,
  type BasesResult,
  ConfigurationInputSchema,
  type DirectoryResult,
  type DownloadLease,
  type EntryResult,
  type InventoryState,
  InventoryStateSchema,
} from "./contracts";

function filesCommands(locale?: string) {
  const t = (text: CloudCliText) => localizeCloudCliText(locale, text);
  const api = (ctx: CloudCliContext) => ctx.createApiClient<ApiType>("/api/filesv2");
  const baseArgs = { base: arg.required({ description: t({ en: "Base ID from bases list", de: "Ablagen-ID aus bases list" }) }) };
  const area = flag.enum(["cloud", "freeipa"], { default: "cloud", description: t({ en: "Storage area", de: "Dateibereich" }) });
  const kind = flag.enum(["users", "groups"], { default: "users", description: t({ en: "Directory kind", de: "Verzeichnisart" }) });
  const after = flag.string({
    description: t({
      en: "Opaque next cursor from the previous JSON response",
      de: "Unveränderter next-Cursor aus der vorherigen JSON-Antwort",
    }),
  });
  const warn = (ctx: CloudCliContext, issue: string | null) => {
    if (issue) ctx.error(`${t({ en: "Storage status", de: "Ablagenstatus" })}: ${issue}`);
  };
  const next = (ctx: CloudCliContext, cursor: string | null) => {
    if (cursor && ctx.options.output === "text") ctx.error(`${t({ en: "Next page: --after", de: "Nächste Seite: --after" })} ${cursor}`);
  };
  const admin = (
    ctx: CloudCliContext,
    query: {
      area?: "cloud" | "freeipa";
      kind?: "users" | "groups";
      after?: string;
      q?: string;
      status?: InventoryState;
      includeEntries?: "false";
    } = {},
  ) =>
    api(ctx)
      .admin.$get({ query })
      .then((response) => ctx.readJson<AdminResult>(response));
  return defineCliCommands({
    name: "filesv2",
    summary: t({ en: "Browse files and administer storage.", de: "Dateien durchsuchen und Ablagen verwalten." }),
    groupSummaries: {
      bases: t({ en: "Inspect accessible homes and group directories", de: "Zugängliche Nutzer- und Gruppenablagen anzeigen" }),
      admin: t({ en: "Inspect and configure storage as an administrator", de: "Ablagen als Administrator prüfen und konfigurieren" }),
      "admin configuration": t({ en: "Read or replace the storage configuration", de: "Ablagenkonfiguration lesen oder ersetzen" }),
      "admin directories": t({
        en: "Create, archive, retire or delete directories",
        de: "Verzeichnisse erstellen, archivieren, stilllegen oder löschen",
      }),
      "admin archives": t({ en: "Inspect, restore or delete archives", de: "Archive prüfen, wiederherstellen oder löschen" }),
      "admin files": t({ en: "Browse and manage files as administrator", de: "Dateien als Administrator durchsuchen und verwalten" }),
      "admin root": t({ en: "Refresh statistics and rebuild the root index", de: "Statistiken aktualisieren und Root-Index neu aufbauen" }),
      "admin operations": t({ en: "Resume pending directory operations", de: "Ausstehende Verzeichnisaktionen fortsetzen" }),
    },
    commands: [
      command("bases list", {
        summary: t({ en: "List accessible storage bases", de: "Zugängliche Ablagen auflisten" }),
        async run({ ctx }) {
          const result = await ctx.readJson<BasesResult>(await api(ctx).bases.$get());
          for (const issue of result.issues) warn(ctx, `${issue.area}: ${issue.code}`);
          printRows(ctx, ctx.options.output === "jsonl" ? result.items : result, result.items, [
            { key: "id", label: "ID" },
            { key: "name", label: t({ en: "Name", de: "Name" }) },
            { key: "area", label: t({ en: "Area", de: "Bereich" }) },
            { key: "kind", label: t({ en: "Kind", de: "Art" }) },
            { key: "status", label: "Status" },
            { key: "reason", label: t({ en: "Reason", de: "Grund" }) },
          ]);
        },
      }),
      command("list", {
        summary: t({ en: "List one directory page", de: "Eine Verzeichnisseite auflisten" }),
        args: baseArgs,
        flags: {
          path: flag.string({ default: "", description: t({ en: "Path relative to the base", de: "Pfad relativ zur Ablage" }) }),
          after,
        },
        async run({ ctx, args, flags }) {
          const result = await ctx.readJson<DirectoryResult>(
            await api(ctx).bases[":baseId"].entries.$get({
              param: { baseId: args.base },
              query: { path: flags.path, after: flags.after },
            }),
          );
          printRows(ctx, ctx.options.output === "jsonl" ? result.items : result, result.items, [
            { key: "path", label: t({ en: "Path", de: "Pfad" }) },
            { key: "directory", label: t({ en: "Directory", de: "Verzeichnis" }) },
            { key: "size", label: "Bytes" },
            { key: "modified", label: t({ en: "Modified", de: "Geändert" }) },
          ]);
          next(ctx, result.next);
        },
      }),
      command("download", {
        summary: t({ en: "Download one file directly from Filegate", de: "Eine Datei direkt von Filegate herunterladen" }),
        args: {
          ...baseArgs,
          path: arg.required({ description: t({ en: "File path relative to the base", de: "Dateipfad relativ zur Ablage" }) }),
        },
        flags: {
          out: flag.string({
            required: true,
            description: t({
              en: "New local output file; existing paths are never overwritten",
              de: "Neue lokale Zieldatei; bestehende Pfade werden nie überschrieben",
            }),
          }),
        },
        examples: ["cld filesv2 download <base-id> Documents/report.pdf --out ./report.pdf"],
        async run({ ctx, args, flags }) {
          if (!flags.out) throw new Error(t({ en: "Pass --out with a new file path.", de: "Gib mit --out einen neuen Dateipfad an." }));
          const result = await downloadFile(ctx, flags.out, async (signal) =>
            ctx.readJson<DownloadLease>(
              await api(ctx).bases[":baseId"].download.$post(
                { param: { baseId: args.base }, json: { path: args.path } },
                { init: { signal } },
              ),
            ),
          );
          if (!printStructured(ctx, result)) ctx.print(`${t({ en: "Saved", de: "Gespeichert" })}: ${result.path} (${result.bytes} bytes)`);
        },
      }),
      command("stat", {
        summary: t({ en: "Inspect a file or folder", de: "Datei oder Ordner prüfen" }),
        args: { ...baseArgs, path: arg.required({ description: t({ en: "Path relative to the base", de: "Pfad relativ zur Ablage" }) }) },
        async run({ ctx, args }) {
          const result = await ctx.readJson<EntryResult>(
            await api(ctx).bases[":baseId"].entry.$get({ param: { baseId: args.base }, query: { path: args.path } }),
          );
          if (!printStructured(ctx, result)) ctx.print(JSON.stringify(result.entry, null, 2));
        },
      }),
      command("thumbnail", {
        summary: t({ en: "Save a generated thumbnail directly from Filegate", de: "Generierte Vorschau direkt von Filegate speichern" }),
        args: {
          ...baseArgs,
          path: arg.required({ description: t({ en: "Image path relative to the base", de: "Bildpfad relativ zur Ablage" }) }),
        },
        flags: { out: flag.string({ required: true }), size: flag.enum(["small", "large"], { default: "small" }) },
        async run({ ctx, args, flags }) {
          const result = await downloadFile(ctx, flags.out!, async (signal) =>
            ctx.readJson<DownloadLease>(
              await api(ctx).bases[":baseId"].thumbnail.$post(
                { param: { baseId: args.base }, json: { path: args.path, size: flags.size } },
                { init: { signal } },
              ),
            ),
          );
          if (!printStructured(ctx, result)) ctx.print(`${result.path} (${result.bytes} bytes)`);
        },
      }),
      command("admin inventory", {
        summary: t({ en: "Inspect filesystem inventory and root statistics", de: "Dateisystembestand und Root-Statistiken prüfen" }),
        flags: {
          area,
          kind,
          after,
          search: flag.string({ description: t({ en: "Filter names on the server", de: "Namen auf dem Server filtern" }) }),
          status: flag.enum(InventoryStateSchema.options, {
            description: t({ en: "Filter inventory status", de: "Bestandsstatus filtern" }),
          }),
        },
        async run({ ctx, flags }) {
          const result = await admin(ctx, {
            area: flags.area,
            kind: flags.kind,
            after: flags.after,
            q: flags.search,
            status: flags.status,
          });
          warn(ctx, result.issue);
          printRows(ctx, ctx.options.output === "jsonl" ? result.items : result, result.items, [
            { key: "identityId", label: "ID" },
            { key: "name", label: "Name" },
            { key: "path", label: t({ en: "Path", de: "Pfad" }) },
            { key: "status", label: "Status" },
            { key: "reason", label: t({ en: "Reason", de: "Grund" }) },
            { key: "uid", label: "UID" },
            { key: "gid", label: "GID" },
            {
              key: "actions",
              label: t({ en: "Actions", de: "Aktionen" }),
              value: (entry) =>
                Object.entries(entry.actions)
                  .filter(([, enabled]) => enabled)
                  .map(([action]) => action)
                  .join(", "),
            },
          ]);
          if (ctx.options.output === "text") {
            const unknown = t({ en: "unknown", de: "unbekannt" });
            ctx.print(
              `${t({ en: "Root", de: "Root" })}: ${result.root?.name ?? unknown}; ${t({ en: "files", de: "Dateien" })}: ${result.root?.files ?? unknown}; bytes: ${result.root?.bytes ?? unknown}`,
            );
          }
          next(ctx, result.next);
        },
      }),
      command("admin configuration get", {
        summary: t({ en: "Read configuration without the backend token", de: "Konfiguration ohne Backend-Token lesen" }),
        async run({ ctx }) {
          const result = await admin(ctx, { includeEntries: "false" });
          if (!printStructured(ctx, result.configuration)) ctx.print(JSON.stringify(result.configuration, null, 2));
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
          const result = await ctx.readJson<{ saved: boolean }>(await api(ctx).admin.configuration.$put({ json: parsed.data }));
          if (!printStructured(ctx, result)) ctx.print(t({ en: "Configuration saved.", de: "Konfiguration gespeichert." }));
        },
      }),
      command("admin adopt", {
        summary: t({
          en: "Assign an existing directory to its current identity",
          de: "Bestehendes Verzeichnis seiner aktuellen Identität zuordnen",
        }),
        args: {
          identity: arg.required({
            description: t({ en: "Identity UUID from admin inventory", de: "Identitäts-UUID aus admin inventory" }),
          }),
        },
        flags: { area, kind, yes: confirmFlag(t({ en: "Confirm assigning the directory", de: "Verzeichniszuordnung bestätigen" })) },
        async run({ ctx, args, flags }) {
          if (!flags.yes)
            throw new Error(t({ en: "Assigning a directory requires --yes.", de: "Die Verzeichniszuordnung erfordert --yes." }));
          const input = AdoptInputSchema.safeParse({ area: flags.area, kind: flags.kind, identityId: args.identity });
          if (!input.success)
            throw new Error(
              t({ en: "Use the identity UUID from admin inventory.", de: "Verwende die Identitäts-UUID aus admin inventory." }),
            );
          const result = await ctx.readJson<unknown>(await api(ctx).admin.adopt.$post({ json: input.data }));
          if (!printStructured(ctx, result)) ctx.print(t({ en: "Directory assigned.", de: "Verzeichnis zugeordnet." }));
        },
      }),
      ...adminLifecycleCommands(locale),
    ],
  });
}

const module = filesCommands();
export default {
  ...module,
  help: (locale?: string) => filesCommands(locale).help!(),
  run: (ctx: CloudCliContext) => filesCommands(ctx.options.locale).run(ctx),
};
