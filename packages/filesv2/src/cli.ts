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
import { uploadFile } from "./cli-upload";
import {
  type AdminResult,
  AdoptInputSchema,
  type ArchiveDownload,
  type BasesResult,
  ConfigurationInputSchema,
  type DirectoryResult,
  type DownloadLease,
  type EntriesResult,
  type EntryResult,
  type FileVersion,
  type InventoryState,
  InventoryStateSchema,
  type MarkedEntry,
  type SearchResult,
  type SharePage,
  type ShareView,
  type TrashEntry,
  type UploadLease,
  type UploadSession,
} from "./contracts";
import { DOCUMENT_KINDS } from "./documents";
import { editorUrl } from "./frontend/urls";

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
      "admin shares": t({ en: "Inspect and revoke all public links", de: "Alle öffentlichen Links prüfen und sperren" }),
      "admin uploads": t({ en: "Inspect unresolved inbox reservations", de: "Ungeklärte Eingangsreservierungen prüfen" }),
      "admin versions": t({ en: "Inspect and permanently delete file versions", de: "Dateiversionen prüfen und endgültig löschen" }),
      "admin root": t({ en: "Refresh statistics and rebuild the root index", de: "Statistiken aktualisieren und Root-Index neu aufbauen" }),
      "admin operations": t({ en: "Resume pending directory operations", de: "Ausstehende Verzeichnisaktionen fortsetzen" }),
      documents: t({ en: "Create office documents for the browser editor", de: "Office-Dokumente für den Browser-Editor anlegen" }),
      trash: t({ en: "List and restore entries in the trash", de: "Einträge im Papierkorb anzeigen und wiederherstellen" }),
      versions: t({ en: "Inspect, comment, download or restore file versions", de: "Dateiversionen prüfen, kommentieren, herunterladen oder wiederherstellen" }),
      shares: t({ en: "Create, list and revoke public shares and inboxes", de: "Öffentliche Freigaben und Eingänge anlegen, auflisten und widerrufen" }),
      favorites: t({ en: "Keep quick access to favorite entries", de: "Schnellzugriff auf Favoriten pflegen" }),
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
      command("archive", {
        summary: t({ en: "Download several entries or folders as one ZIP directly from Filegate", de: "Mehrere Einträge oder Ordner als ein ZIP direkt von Filegate herunterladen" }),
        args: { ...baseArgs, paths: arg.rest({ description: t({ en: "Entry paths relative to the base (1-100)", de: "Eintragspfade relativ zur Ablage (1-100)" }) }) },
        flags: { out: flag.string({ required: true, description: t({ en: "New local ZIP file; existing paths are never overwritten", de: "Neue lokale ZIP-Datei; bestehende Pfade werden nie überschrieben" }) }) },
        examples: ["cld filesv2 archive <base-id> Documents Photos/team.jpg --out ./selection.zip"],
        async run({ ctx, args, flags }) {
          if (!flags.out) throw new Error(t({ en: "Pass --out with a new file path.", de: "Gib mit --out einen neuen Dateipfad an." }));
          if (!args.paths.length) throw new Error(t({ en: "Pass at least one path.", de: "Gib mindestens einen Pfad an." }));
          const result = await downloadFile(ctx, flags.out, async (signal) =>
            ctx.readJson<ArchiveDownload>(await api(ctx).bases[":baseId"].archive.$post({ param: { baseId: args.base }, json: { paths: args.paths } }, { init: { signal } })),
          );
          if (!printStructured(ctx, result)) ctx.print(`${t({ en: "Saved", de: "Gespeichert" })}: ${result.path} (${result.bytes} bytes)`);
        },
      }),
      command("search", {
        summary: t({ en: "Search names below a folder", de: "Namen unterhalb eines Ordners suchen" }),
        args: { ...baseArgs, query: arg.required({ description: t({ en: "Name fragment", de: "Namensbestandteil" }) }) },
        flags: {
          path: flag.string({ default: "", description: t({ en: "Folder to search below", de: "Ordner, unterhalb dessen gesucht wird" }) }),
          scope: flag.enum(["tree", "folder"], { default: "tree", description: t({ en: "tree searches all levels below the folder, folder only its direct entries", de: "tree durchsucht alle Ebenen unter dem Ordner, folder nur seine direkten Einträge" }) }),
          after,
        },
        async run({ ctx, args, flags }) {
          const result = await ctx.readJson<SearchResult>(
            await api(ctx).bases[":baseId"].search.$get({
              param: { baseId: args.base },
              query: { q: args.query, path: flags.path, scope: flags.scope ?? "tree", after: flags.after },
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
      command("mkdir", {
        summary: t({ en: "Create a folder", de: "Ordner anlegen" }),
        args: { ...baseArgs, path: arg.required({ description: t({ en: "New folder path relative to the base", de: "Neuer Ordnerpfad relativ zur Ablage" }) }) },
        async run({ ctx, args }) {
          const result = await ctx.readJson<EntryResult>(
            await api(ctx).bases[":baseId"].directories.$post({ param: { baseId: args.base }, json: { path: args.path } }),
          );
          if (!printStructured(ctx, result)) ctx.print(`${t({ en: "Created", de: "Angelegt" })}: ${result.entry.path}`);
        },
      }),
      command("upload", {
        summary: t({ en: "Upload one local file directly to Filegate", de: "Eine lokale Datei direkt zu Filegate hochladen" }),
        args: {
          ...baseArgs,
          file: arg.required({ description: t({ en: "Local file to upload", de: "Lokale Datei zum Hochladen" }) }),
        },
        flags: {
          to: flag.string({
            required: true,
            description: t({ en: "Target file path relative to the base", de: "Zieldateipfad relativ zur Ablage" }),
          }),
          replace: flag.boolean({ description: t({ en: "Replace an existing file at the target path", de: "Bestehende Datei am Zielpfad ersetzen" }) }),
        },
        examples: ["cld filesv2 upload <base-id> ./report.pdf --to Documents/report.pdf"],
        async run({ ctx, args, flags }) {
          const param = { baseId: args.base };
          const result = await uploadFile(ctx, args.file, {
            open: async (size, signal) =>
              ctx.readJson<UploadSession>(
                await api(ctx).bases[":baseId"].uploads.$post(
                  { param, json: { path: flags.to!, size, onConflict: flags.replace ? "overwrite" : "error" } },
                  { init: { signal } },
                ),
              ),
            renew: async (id, signal) => ctx.readJson<UploadLease>(await api(ctx).bases[":baseId"].uploads[":id"].lease.$post({ param: { ...param, id } }, { init: { signal } })),
            commit: async (id, signal) => ctx.readJson<EntryResult>(await api(ctx).bases[":baseId"].uploads[":id"].commit.$post({ param: { ...param, id } }, { init: { signal } })),
            abort: async (id, signal) => {
              await api(ctx).bases[":baseId"].uploads[":id"].abort.$post({ param: { ...param, id } }, { init: { signal } });
            },
          });
          if (!printStructured(ctx, result)) ctx.print(`${t({ en: "Uploaded", de: "Hochgeladen" })}: ${result.entry.path} (${result.entry.size} bytes)`);
        },
      }),
      command("recent", {
        summary: t({ en: "List recently opened entries", de: "Zuletzt geöffnete Einträge auflisten" }),
        async run({ ctx }) {
          const items = await ctx.readJson<MarkedEntry[]>(await api(ctx).recent.$get());
          printRows(ctx, items, items.map((item) => ({ base: item.base.name, baseId: item.base.id, path: item.entry.path, markedAt: item.markedAt })), [
            { key: "base", label: t({ en: "Base", de: "Ablage" }) },
            { key: "path", label: t({ en: "Path", de: "Pfad" }) },
            { key: "markedAt", label: t({ en: "Opened", de: "Geöffnet" }) },
          ]);
        },
      }),
      command("favorites list", {
        summary: t({ en: "List favorite entries", de: "Favoriten auflisten" }),
        async run({ ctx }) {
          const items = await ctx.readJson<MarkedEntry[]>(await api(ctx).favorites.$get());
          printRows(ctx, items, items.map((item) => ({ base: item.base.name, baseId: item.base.id, path: item.entry.path })), [
            { key: "base", label: t({ en: "Base", de: "Ablage" }) },
            { key: "path", label: t({ en: "Path", de: "Pfad" }) },
          ]);
        },
      }),
      command("favorites add", {
        summary: t({ en: "Mark an entry as favorite", de: "Eintrag als Favorit markieren" }),
        args: { ...baseArgs, path: arg.required({ description: t({ en: "Entry path relative to the base", de: "Eintragspfad relativ zur Ablage" }) }) },
        async run({ ctx, args }) {
          const result = await ctx.readJson<{ favorite: boolean }>(await api(ctx).bases[":baseId"].favorite.$post({ param: { baseId: args.base }, json: { path: args.path, favorite: true } }));
          if (!printStructured(ctx, result)) ctx.print(`${t({ en: "Favorite", de: "Favorit" })}: ${args.path}`);
        },
      }),
      command("favorites remove", {
        summary: t({ en: "Remove an entry from the favorites", de: "Eintrag aus den Favoriten entfernen" }),
        args: { ...baseArgs, path: arg.required({ description: t({ en: "Entry path relative to the base", de: "Eintragspfad relativ zur Ablage" }) }) },
        async run({ ctx, args }) {
          const result = await ctx.readJson<{ favorite: boolean }>(await api(ctx).bases[":baseId"].favorite.$post({ param: { baseId: args.base }, json: { path: args.path, favorite: false } }));
          if (!printStructured(ctx, result)) ctx.print(`${t({ en: "Removed from favorites", de: "Aus Favoriten entfernt" })}: ${args.path}`);
        },
      }),
      command("documents create", {
        summary: t({ en: "Create an empty office document in the configured format", de: "Leeres Office-Dokument im konfigurierten Format anlegen" }),
        args: {
          ...baseArgs,
          path: arg.required({ description: t({ en: "Target path relative to the base, without extension", de: "Zielpfad relativ zur Ablage, ohne Endung" }) }),
        },
        flags: {
          kind: flag.enum(DOCUMENT_KINDS, { default: "text", description: t({ en: "text, spreadsheet or presentation", de: "text, spreadsheet oder presentation" }) }),
        },
        examples: ["cld filesv2 documents create <base-id> Documents/Minutes --kind text"],
        async run({ ctx, args, flags }) {
          const result = await ctx.readJson<EntryResult>(
            await api(ctx).bases[":baseId"].documents.$post({ param: { baseId: args.base }, json: { path: args.path, kind: flags.kind ?? "text" } }),
          );
          if (!printStructured(ctx, result)) ctx.print(`${t({ en: "Created", de: "Angelegt" })}: ${result.entry.path}`);
        },
      }),
      command("edit-url", {
        summary: t({ en: "Print the browser address that opens a file in the editor", de: "Browser-Adresse ausgeben, die eine Datei im Editor öffnet" }),
        args: { ...baseArgs, path: arg.required({ description: t({ en: "File path relative to the base", de: "Dateipfad relativ zur Ablage" }) }) },
        async run({ ctx, args }) {
          const url = new URL(editorUrl(args.base, args.path), ctx.options.server).href;
          if (!printStructured(ctx, { url })) ctx.print(url);
        },
      }),
      command("rename", {
        summary: t({ en: "Rename a file or folder", de: "Datei oder Ordner umbenennen" }),
        args: { ...baseArgs, path: arg.required({ description: t({ en: "Path relative to the base", de: "Pfad relativ zur Ablage" }) }), name: arg.required({ description: t({ en: "New name", de: "Neuer Name" }) }) },
        async run({ ctx, args }) {
          const result = await ctx.readJson<EntryResult>(await api(ctx).bases[":baseId"].rename.$post({ param: { baseId: args.base }, json: { path: args.path, name: args.name } }));
          if (!printStructured(ctx, result)) ctx.print(`${t({ en: "Renamed", de: "Umbenannt" })}: ${result.entry.path}`);
        },
      }),
      command("move", {
        summary: t({ en: "Move entries into a folder of the same base", de: "Einträge in einen Ordner derselben Ablage verschieben" }),
        args: { ...baseArgs, paths: arg.rest({ description: t({ en: "Paths relative to the base", de: "Pfade relativ zur Ablage" }) }) },
        flags: { to: flag.string({ required: true, description: t({ en: "Target folder relative to the base", de: "Zielordner relativ zur Ablage" }) }) },
        async run({ ctx, args, flags }) {
          const result = await ctx.readJson<EntriesResult>(await api(ctx).bases[":baseId"].move.$post({ param: { baseId: args.base }, json: { paths: args.paths, folder: flags.to! } }));
          printRows(ctx, ctx.options.output === "jsonl" ? result.results : result, result.results, [{ key: "path", label: t({ en: "Path", de: "Pfad" }) }, { key: "ok", label: "OK" }, { key: "error", label: t({ en: "Error", de: "Fehler" }) }]);
          if (result.results.some(item => !item.ok)) return 1;
        },
      }),
      command("copy", {
        summary: t({ en: "Copy entries into a folder of this or another base", de: "Einträge in einen Ordner dieser oder einer anderen Ablage kopieren" }),
        args: { ...baseArgs, paths: arg.rest({ description: t({ en: "Paths relative to the base", de: "Pfade relativ zur Ablage" }) }) },
        flags: {
          to: flag.string({ required: true, description: t({ en: "Target folder relative to the target base", de: "Zielordner relativ zur Zielablage" }) }),
          "target-base": flag.string({ description: t({ en: "Target base ID; defaults to the source base", de: "Ziel-Ablage-ID; Standard ist die Quellablage" }) }),
        },
        async run({ ctx, args, flags }) {
          const result = await ctx.readJson<EntriesResult>(
            await api(ctx).bases[":baseId"].copy.$post({ param: { baseId: args.base }, json: { paths: args.paths, targetBaseId: flags["target-base"] ?? args.base, folder: flags.to! } }),
          );
          printRows(ctx, ctx.options.output === "jsonl" ? result.results : result, result.results, [{ key: "path", label: t({ en: "Path", de: "Pfad" }) }, { key: "ok", label: "OK" }, { key: "error", label: t({ en: "Error", de: "Fehler" }) }]);
          if (result.results.some(item => !item.ok)) return 1;
        },
      }),
      command("delete", {
        summary: t({ en: "Move entries to the trash", de: "Einträge in den Papierkorb verschieben" }),
        args: { ...baseArgs, paths: arg.rest({ description: t({ en: "Paths relative to the base", de: "Pfade relativ zur Ablage" }) }) },
        async run({ ctx, args }) {
          const result = await ctx.readJson<{ entries: TrashEntry[]; results: ({path:string;ok:true;entry:TrashEntry}|{path:string;ok:false;error:string})[] }>(await api(ctx).bases[":baseId"].delete.$post({ param: { baseId: args.base }, json: { paths: args.paths } }));
          printRows(ctx, ctx.options.output === "jsonl" ? result.results : result, result.results, [
            { key: "path", label: t({ en: "Path", de: "Pfad" }) }, { key: "ok", label: "OK" }, { key: "error", label: t({ en: "Error", de: "Fehler" }) },
          ]);
          if (result.results.some(item => !item.ok)) return 1;
        },
      }),
      command("trash list", {
        summary: t({ en: "List trashed entries of a base", de: "Papierkorb einer Ablage auflisten" }),
        args: baseArgs, flags: { after },
        async run({ ctx, args, flags }) {
          const result = await ctx.readJson<{ entries: TrashEntry[]; next: string | null }>(await api(ctx).bases[":baseId"].trash.$get({ param: { baseId: args.base }, query: { after: flags.after } }));
          next(ctx, result.next);
          printRows(ctx, ctx.options.output === "jsonl" ? result.entries : result, result.entries, [
            { key: "id", label: "ID" },
            { key: "original", label: t({ en: "Original path", de: "Ursprünglicher Pfad" }) },
            { key: "deletedAt", label: t({ en: "Deleted", de: "Gelöscht" }) },
          ]);
        },
      }),
      command("trash restore", {
        summary: t({ en: "Restore a trashed entry to its original path", de: "Eintrag aus dem Papierkorb an den ursprünglichen Ort zurücklegen" }),
        args: { ...baseArgs, id: arg.required({ description: t({ en: "Trash entry ID", de: "Papierkorb-ID" }) }) },
        flags: { to: flag.string({ description: t({ en: "Restore target relative to the base; required when original path is unknown", de: "Wiederherstellungsziel relativ zur Ablage; bei unbekanntem Ursprung erforderlich" }) }) },
        async run({ ctx, args, flags }) {
          const result = await ctx.readJson<EntryResult>(await api(ctx).bases[":baseId"].trash[":id"].restore.$post({ param: { baseId: args.base, id: args.id }, query: { path: flags.to } }));
          if (!printStructured(ctx, result)) ctx.print(`${t({ en: "Restored", de: "Wiederhergestellt" })}: ${result.entry.path}`);
        },
      }),
      command("versions list", {
        summary: t({ en: "List versions of a file", de: "Versionen einer Datei auflisten" }),
        args: { ...baseArgs, path: arg.required({ description: t({ en: "File path relative to the base", de: "Dateipfad relativ zur Ablage" }) }) },
        async run({ ctx, args }) {
          const result = await ctx.readJson<FileVersion[]>(await api(ctx).bases[":baseId"].versions.$get({ param: { baseId: args.base }, query: { path: args.path } }));
          printRows(ctx, result, result, [
            { key: "id", label: "ID" },
            { key: "created", label: t({ en: "Created", de: "Erstellt" }) },
            { key: "size", label: "Bytes" },
            { key: "comment", label: t({ en: "Comment", de: "Kommentar" }) },
          ]);
        },
      }),
      command("versions download", {
        summary: t({ en: "Download one historical version directly from Filegate", de: "Eine frühere Version direkt von Filegate herunterladen" }),
        args: { ...baseArgs, path: arg.required({ description: t({ en: "File path relative to the base", de: "Dateipfad relativ zur Ablage" }) }), id: arg.required({ description: t({ en: "Version ID", de: "Versions-ID" }) }) },
        flags: { out: flag.string({ required: true, description: t({ en: "New local output file; existing paths are never overwritten", de: "Neue lokale Zieldatei; bestehende Pfade werden nie überschrieben" }) }) },
        examples: ["cld filesv2 versions download <base-id> Documents/report.pdf <version-id> --out ./report-v1.pdf"],
        async run({ ctx, args, flags }) {
          if (!flags.out) throw new Error(t({ en: "Pass --out with a new file path.", de: "Gib mit --out einen neuen Dateipfad an." }));
          const result = await downloadFile(ctx, flags.out, async (signal) =>
            ctx.readJson<DownloadLease>(
              await api(ctx).bases[":baseId"].versions.download.$post({ param: { baseId: args.base }, json: { path: args.path, id: args.id } }, { init: { signal } }),
            ),
          );
          if (!printStructured(ctx, result)) ctx.print(`${t({ en: "Saved", de: "Gespeichert" })}: ${result.path} (${result.bytes} bytes)`);
        },
      }),
      command("versions restore", {
        summary: t({ en: "Restore a version in place or as a new file", de: "Version an Ort und Stelle oder als neue Datei wiederherstellen" }),
        args: { ...baseArgs, path: arg.required({ description: t({ en: "File path relative to the base", de: "Dateipfad relativ zur Ablage" }) }), id: arg.required({ description: t({ en: "Version ID", de: "Versions-ID" }) }) },
        flags: { as: flag.string({ description: t({ en: "Restore as a new file with this name", de: "Als neue Datei mit diesem Namen wiederherstellen" }) }) },
        async run({ ctx, args, flags }) {
          const param = { baseId: args.base };
          const result = await ctx.readJson<EntryResult>(
            flags.as
              ? await api(ctx).bases[":baseId"].versions["restore-as"].$post({ param, json: { path: args.path, id: args.id, name: flags.as } })
              : await api(ctx).bases[":baseId"].versions.restore.$post({ param, json: { path: args.path, id: args.id } }),
          );
          if (!printStructured(ctx, result)) ctx.print(`${t({ en: "Restored", de: "Wiederhergestellt" })}: ${result.entry.path}`);
        },
      }),
      command("versions comment", {
        summary: t({ en: "Set the comment of a version", de: "Kommentar einer Version setzen" }),
        args: { ...baseArgs, path: arg.required({ description: t({ en: "File path relative to the base", de: "Dateipfad relativ zur Ablage" }) }), id: arg.required({ description: t({ en: "Version ID", de: "Versions-ID" }) }), comment: arg.required({ description: t({ en: "Comment text", de: "Kommentartext" }) }) },
        async run({ ctx, args }) {
          const result = await ctx.readJson<FileVersion>(await api(ctx).bases[":baseId"].versions.comment.$post({ param: { baseId: args.base }, json: { path: args.path, id: args.id, comment: args.comment } }));
          if (!printStructured(ctx, result)) ctx.print(`${result.id}: ${result.comment ?? ""}`);
        },
      }),
      command("shares list", {
        summary: t({ en: "List public shares visible to you", de: "Für dich sichtbare öffentliche Freigaben auflisten" }),
        flags: { after },
        async run({ ctx, flags }) {
          const result = await ctx.readJson<SharePage>(await api(ctx).shares.$get({ query: { after: flags.after } }));
          next(ctx, result.next);
          printRows(ctx, ctx.options.output === "jsonl" ? result.items : result, result.items, [
            { key: "id", label: "ID" },
            { key: "kind", label: t({ en: "Kind", de: "Art" }) },
            { key: "title", label: t({ en: "Name", de: "Name" }) },
            { key: "state", label: "Status" },
            { key: "expiresAt", label: t({ en: "Expires", de: "Läuft ab" }) },
            { key: "url", label: "URL" },
          ]);
        },
      }),
      command("shares create", {
        summary: t({ en: "Create a public download share or an upload inbox", de: "Öffentliche Download-Freigabe oder Upload-Eingang erstellen" }),
        args: { ...baseArgs, paths: arg.rest({ description: t({ en: "Entries to share (download) or one folder (inbox)", de: "Einträge (Download) oder ein Ordner (Eingang)" }) }) },
        flags: {
          kind: flag.enum(["download", "inbox"], { default: "download" }),
          title: flag.string({ required: true, description: t({ en: "Name shown to visitors", de: "Name, den Besucher sehen" }) }),
          "expires-in": flag.enum(["1d", "7d", "30d", "90d", "unlimited"], { default: "30d" }),
          note: flag.string({ description: t({ en: "Private management note", de: "Private Verwaltungsnotiz" }) }),
          "public-note": flag.string({ description: t({ en: "Public note for visitors", de: "Öffentlicher Hinweis für Besucher" }) }),
          "max-file-size": flag.int({ default: 104857600, description: t({ en: "Inbox limit per file in bytes", de: "Eingangslimit pro Datei in Bytes" }) }),
          "max-total-size": flag.int({ default: 1073741824, description: t({ en: "Cumulative inbox limit in bytes", de: "Kumulatives Eingangslimit in Bytes" }) }),
          "show-upload-names": flag.boolean({ description: t({ en: "Show names of successful inbox uploads to visitors", de: "Namen erfolgreicher Eingangs-Uploads für Besucher anzeigen" }) }),
        },
        async run({ ctx, args, flags }) {
          const result = await ctx.readJson<ShareView>(
            await api(ctx).bases[":baseId"].shares.$post({
              param: { baseId: args.base },
              json: { kind: flags.kind ?? "download", paths: (flags.kind ?? "download") === "download" ? args.paths : [], folder: flags.kind === "inbox" ? (args.paths[0] ?? "") : "", title: flags.title!, note: flags.note, publicNote: flags["public-note"], expiresIn: flags["expires-in"], maxFileSize: flags["max-file-size"], maxTotalSize: flags["max-total-size"], showUploadNames: flags["show-upload-names"] },
            }),
          );
          if (!printStructured(ctx, result)) ctx.print(result.url ?? "");
        },
      }),
      command("shares revoke", {
        summary: t({ en: "Revoke a public share", de: "Öffentliche Freigabe widerrufen" }),
        args: { id: arg.required({ description: t({ en: "Share ID", de: "Freigabe-ID" }) }) },
        async run({ ctx, args }) {
          const result = await ctx.readJson<ShareView>(await api(ctx).shares[":id"].revoke.$post({ param: { id: args.id } }));
          if (!printStructured(ctx, result)) ctx.print(`${result.title}: ${result.state}`);
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
