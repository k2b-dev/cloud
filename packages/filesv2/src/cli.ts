import { stat as localStat } from "node:fs/promises";
import { basename, join } from "node:path";
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
} from "@k2b/cloud/cli";
import type { ApiType } from "./api";
import { addressOf, areaLabel, type FileTarget, fileResolver } from "./cli-address";
import { adminCommands } from "./cli-admin";
import { downloadFile, readFile } from "./cli-download";
import { templateCommands } from "./cli-templates";
import { uploadFile } from "./cli-upload";
import {
  type ArchiveDownload,
  type BasesResult,
  CONTENT_STREAM_LIMIT,
  type DirectoryResult,
  type DownloadLease,
  type EntriesResult,
  type EntryResult,
  type FileEntry,
  type FileVersion,
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

/** The server's scan budget for one listing or search; `tree` stops at the same size instead of paging forever. */
const TREE_LIMIT = 10_000;

const joinPath = (...parts: string[]) => parts.filter(Boolean).join("/");
const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
const nameOf = (path: string) => path.split("/").at(-1) ?? "";
const isStatus = (error: unknown, status: number) => error instanceof Error && error.message.startsWith(`${status} `);

function filesCommands(locale?: string) {
  const t = (text: CloudCliText) => localizeCloudCliText(locale, text);
  const api = (ctx: CloudCliContext) => ctx.createApiClient<ApiType>("/api/filesv2");
  const param = (target: { baseId: string }) => ({ baseId: target.baseId });

  const fileArg = (text: CloudCliText) => arg.required({ valueLabel: "file", description: t(text) });
  const fileArgs = (text: CloudCliText) => arg.rest({ valueLabel: "file", required: true, description: t(text) });
  const areaArg = arg.required({
    valueLabel: "area",
    description: t({ en: "me, a group name or an area ID", de: "me, ein Gruppenname oder eine Bereichs-ID" }),
  });
  const yes = confirmFlag(t({ en: "Confirm this operation", de: "Diese Aktion bestätigen" }));
  const after = flag.string({
    description: t({
      en: "Unchanged next cursor from the previous JSON response",
      de: "Unveränderter next-Cursor aus der vorherigen JSON-Antwort",
    }),
  });
  const browseFlags = {
    sort: flag.enum(["name", "modified", "size"], {
      default: "name",
      description: t({ en: "Sort the complete result before pagination", de: "Gesamtes Ergebnis vor der Paginierung sortieren" }),
    }),
    order: flag.enum(["asc", "desc"], { default: "asc", description: t({ en: "Sort direction", de: "Sortierreihenfolge" }) }),
    type: flag.enum(["all", "files", "directories"], { default: "all", description: t({ en: "Entry type", de: "Eintragsart" }) }),
    noGroupFolders: flag.boolean({
      name: "no-group-folders",
      description: t({
        en: "Mix folders and files; folders are grouped first by default",
        de: "Ordner und Dateien mischen; standardmäßig stehen Ordner zuerst",
      }),
    }),
  };
  const browseQuery = (flags: {
    sort?: "name" | "modified" | "size";
    order?: "asc" | "desc";
    type?: "all" | "files" | "directories";
    noGroupFolders: boolean;
  }) => ({
    sort: flags.sort,
    order: flags.order,
    type: flags.type,
    groupFolders: flags.noGroupFolders ? ("false" as const) : ("true" as const),
  });
  const requireYes = (value: boolean) => {
    if (!value) throw new Error(t({ en: "This operation requires --yes.", de: "Diese Aktion erfordert --yes." }));
  };
  const requireEntry = (target: FileTarget) => {
    if (!target.path)
      throw new Error(
        t({
          en: "Name a file or folder inside the area, not the area itself.",
          de: "Gib eine Datei oder einen Ordner im Bereich an, nicht den Bereich selbst.",
        }),
      );
    return target.path;
  };
  const next = (ctx: CloudCliContext, cursor: string | null) => {
    if (cursor && ctx.options.output === "text") ctx.error(`${t({ en: "Next page: --after", de: "Nächste Seite: --after" })} ${cursor}`);
  };
  const saved = (ctx: CloudCliContext, result: { path: string; bytes: number }) => {
    if (!printStructured(ctx, result)) ctx.print(`${t({ en: "Saved", de: "Gespeichert" })}: ${result.path} (${result.bytes} bytes)`);
  };
  const entry = async (ctx: CloudCliContext, target: FileTarget & { entry?: EntryResult }) =>
    target.entry ??
    ctx.readJson<EntryResult>(await api(ctx).bases[":baseId"].entry.$get({ param: param(target), query: { path: requireEntry(target) } }));
  const entryOrNull = (ctx: CloudCliContext, target: FileTarget) =>
    entry(ctx, target).catch((error: unknown) => {
      if (isStatus(error, 404)) return null;
      throw error;
    });
  const mkdir = async (ctx: CloudCliContext, baseId: string, path: string) =>
    ctx.readJson<EntryResult>(await api(ctx).bases[":baseId"].directories.$post({ param: { baseId }, json: { path } }));
  /** Creates every missing folder of `path`; an existing folder is fine, an existing file is not. */
  const mkdirParents = async (ctx: CloudCliContext, baseId: string, path: string) => {
    let result: EntryResult | undefined;
    const segments = path.split("/").filter(Boolean);
    for (let index = 1; index <= segments.length; index++) {
      const current = segments.slice(0, index).join("/");
      result = await mkdir(ctx, baseId, current).catch(async (error: unknown) => {
        if (!isStatus(error, 409)) throw error;
        const existing = await entry(ctx, { baseId, path: current, folder: true });
        if (!existing.entry.directory) throw error;
        return existing;
      });
    }
    return result;
  };
  /** Local target for a download: the given path, a file inside a given local folder, or the remote name in the working directory. */
  const localTarget = async (local: string | undefined, name: string) => {
    if (!local) return name;
    const info = await localStat(local).catch(() => null);
    return info?.isDirectory() ? join(local, name) : local;
  };
  const batch = (ctx: CloudCliContext, result: { results: { path: string; ok: boolean; error?: string }[] }) => {
    printRows(ctx, ctx.options.output === "jsonl" ? result.results : result, result.results, [
      { key: "path", label: t({ en: "Path", de: "Pfad" }) },
      { key: "ok", label: "OK" },
      { key: "error", label: t({ en: "Error", de: "Fehler" }) },
    ]);
    if (result.results.some((item) => !item.ok)) return 1;
  };
  const entryRows = (ctx: CloudCliContext, value: unknown, items: FileEntry[], key: "name" | "path") =>
    printRows(ctx, ctx.options.output === "jsonl" ? items : value, items, [
      {
        key,
        label: key === "name" ? t({ en: "Name", de: "Name" }) : t({ en: "Path", de: "Pfad" }),
        value: (item) => `${item[key]}${item.directory ? "/" : ""}`,
      },
      { key: "size", label: "Bytes", value: (item) => (item.directory ? "" : item.size) },
      { key: "modified", label: t({ en: "Modified", de: "Geändert" }) },
    ]);
  const markedRows = (ctx: CloudCliContext, items: MarkedEntry[], column: CloudCliText) =>
    printRows(
      ctx,
      items,
      items.map((item) => ({ address: addressOf(item.base, item.entry.path), markedAt: item.markedAt })),
      [
        { key: "address", label: t({ en: "Address", de: "Adresse" }) },
        { key: "markedAt", label: t(column) },
      ],
    );

  return defineCliCommands({
    name: "filesv2",
    summary: t({
      en: "Work with personal and group files and administer storage.",
      de: "Mit persönlichen und Gruppendateien arbeiten und Ablagen verwalten.",
    }),
    groupSummaries: {
      trash: t({
        en: "List and restore entries in an area's trash",
        de: "Einträge im Papierkorb eines Bereichs anzeigen und wiederherstellen",
      }),
      versions: t({
        en: "Inspect, download, comment and restore file versions",
        de: "Dateiversionen prüfen, herunterladen, kommentieren und wiederherstellen",
      }),
      shares: t({
        en: "Create, list and revoke public links and inboxes",
        de: "Öffentliche Links und Eingänge anlegen, auflisten und widerrufen",
      }),
      favorites: t({ en: "Keep quick access to favorite entries", de: "Schnellzugriff auf Favoriten pflegen" }),
      documents: t({ en: "Create documents for the browser editors", de: "Dokumente für die Browser-Editoren anlegen" }),
      templates: t({ en: "Find and use independent file templates", de: "Unabhängige Dateivorlagen finden und nutzen" }),
      admin: t({ en: "Inspect and configure storage as an administrator", de: "Ablagen als Administrator prüfen und konfigurieren" }),
      "admin configuration": t({ en: "Read or replace the storage configuration", de: "Ablagenkonfiguration lesen oder ersetzen" }),
      "admin directories": t({
        en: "Create, archive, retire or delete directories",
        de: "Verzeichnisse erstellen, archivieren, stilllegen oder löschen",
      }),
      "admin archives": t({ en: "Inspect, restore or delete archives", de: "Archive prüfen, wiederherstellen oder löschen" }),
      "admin files": t({
        en: "Browse, download and permanently delete files as administrator",
        de: "Dateien als Administrator durchsuchen, herunterladen und endgültig löschen",
      }),
      "admin shares": t({ en: "Inspect and revoke all public links", de: "Alle öffentlichen Links prüfen und sperren" }),
      "admin uploads": t({ en: "Inspect unresolved inbox reservations", de: "Ungeklärte Eingangsreservierungen prüfen" }),
      "admin versions": t({ en: "Inspect and permanently delete file versions", de: "Dateiversionen prüfen und endgültig löschen" }),
      "admin root": t({ en: "Refresh statistics and rebuild the root index", de: "Statistiken aktualisieren und Root-Index neu aufbauen" }),
      "admin operations": t({ en: "Resume pending directory operations", de: "Ausstehende Verzeichnisaktionen fortsetzen" }),
      "admin templates": t({ en: "Manage template snapshots and grants", de: "Vorlagenkopien und Nutzungsrechte verwalten" }),
      "admin templates access": t({ en: "Manage template use permissions", de: "Nutzungsrechte für Vorlagen verwalten" }),
    },
    commands: [
      command("ls", {
        summary: t({ en: "List your areas, or one folder page", de: "Deine Bereiche oder eine Ordnerseite auflisten" }),
        description: t({
          en: "Without an address, lists the areas you can use: me (your personal area) and your groups. With <area>:/path, lists one page of that folder.",
          de: "Ohne Adresse listet der Befehl deine Bereiche auf: me (dein persönlicher Bereich) und deine Gruppen. Mit <bereich>:/pfad listet er eine Seite dieses Ordners.",
        }),
        args: {
          folder: arg.optional({
            valueLabel: "folder",
            description: t({ en: "<area>:/path or a folder ID", de: "<bereich>:/pfad oder eine Ordner-ID" }),
          }),
        },
        flags: { after, ...browseFlags },
        examples: ["cld filesv2 ls", "cld filesv2 ls me:/Documents --sort modified --order desc"],
        async run({ ctx, args, flags }) {
          if (!args.folder) {
            const result = await ctx.readJson<BasesResult>(await api(ctx).bases.$get());
            for (const issue of result.issues)
              ctx.error(`${t({ en: "Storage status", de: "Ablagenstatus" })}: ${issue.area}: ${issue.code}`);
            printRows(ctx, ctx.options.output === "jsonl" ? result.items : result, result.items, [
              { key: "area", label: t({ en: "Area", de: "Bereich" }), value: (base) => areaLabel(base) },
              { key: "id", label: "ID" },
              { key: "storage", label: t({ en: "Storage", de: "Ablage" }), value: (base) => base.area },
              { key: "status", label: "Status" },
              { key: "reason", label: t({ en: "Reason", de: "Grund" }) },
            ]);
            return;
          }
          const target = await fileResolver(ctx).file(args.folder);
          const result = await ctx.readJson<DirectoryResult>(
            await api(ctx).bases[":baseId"].entries.$get({
              param: param(target),
              query: { path: target.path, after: flags.after, ...browseQuery(flags) },
            }),
          );
          entryRows(ctx, result, result.items, "name");
          next(ctx, result.next);
        },
      }),
      command("tree", {
        summary: t({ en: "List a folder and its subfolders", de: "Einen Ordner mit Unterordnern auflisten" }),
        description: t({
          en: `Follows every page down to --depth levels. Stops with an error above ${TREE_LIMIT} entries; narrow the folder or lower --depth.`,
          de: `Folgt allen Seiten bis zu --depth Ebenen. Bricht über ${TREE_LIMIT} Einträgen mit einem Fehler ab; wähle einen engeren Ordner oder eine kleinere --depth.`,
        }),
        args: {
          folder: arg.required({
            valueLabel: "folder",
            description: t({ en: "<area>:/path or a folder ID", de: "<bereich>:/pfad oder eine Ordner-ID" }),
          }),
        },
        flags: {
          depth: flag.int({
            default: 3,
            min: 1,
            max: 32,
            description: t({ en: "Folder levels to descend", de: "Anzahl der Ordnerebenen" }),
          }),
        },
        async run({ ctx, args, flags }) {
          const target = await fileResolver(ctx).file(args.folder);
          const depth = flags.depth ?? 3;
          const items: (FileEntry & { depth: number })[] = [];
          let base: DirectoryResult["base"] | undefined;
          const walk = async (path: string, level: number) => {
            let cursor: string | undefined;
            do {
              const page = await ctx.readJson<DirectoryResult>(
                await api(ctx).bases[":baseId"].entries.$get({ param: param(target), query: { path, after: cursor } }),
              );
              base ??= page.base;
              for (const item of page.items) {
                items.push({ ...item, depth: level });
                if (items.length > TREE_LIMIT)
                  throw new Error(
                    t({
                      en: `The tree has more than ${TREE_LIMIT} entries. Choose a narrower folder or a lower --depth.`,
                      de: `Der Baum hat mehr als ${TREE_LIMIT} Einträge. Wähle einen engeren Ordner oder eine kleinere --depth.`,
                    }),
                  );
                if (item.directory && level < depth) await walk(item.path, level + 1);
              }
              cursor = page.next ?? undefined;
            } while (cursor);
          };
          await walk(target.path, 1);
          if (printStructured(ctx, { base, path: target.path, depth, items })) return;
          ctx.print(`${addressOf(base ?? { name: target.baseId }, target.path)}`);
          for (const item of items) ctx.print(`${"  ".repeat(item.depth)}${item.name}${item.directory ? "/" : ""}`);
        },
      }),
      command("stat", {
        summary: t({ en: "Show a file's or folder's details", de: "Details einer Datei oder eines Ordners anzeigen" }),
        args: { file: fileArg({ en: "<area>:/path or a file ID", de: "<bereich>:/pfad oder eine Datei-ID" }) },
        async run({ ctx, args }) {
          const result = await entry(ctx, await fileResolver(ctx).file(args.file));
          if (printStructured(ctx, result)) return;
          const rows: [string, unknown][] = [
            [t({ en: "Address", de: "Adresse" }), addressOf(result.base, result.entry.path)],
            [t({ en: "Type", de: "Art" }), result.entry.directory ? t({ en: "folder", de: "Ordner" }) : t({ en: "file", de: "Datei" })],
            ["Bytes", result.entry.size],
            [t({ en: "Modified", de: "Geändert" }), result.entry.modified],
            [t({ en: "Revision", de: "Revision" }), result.entry.revision ?? ""],
            [t({ en: "File ID", de: "Datei-ID" }), result.resourceId ?? ""],
            [t({ en: "Area ID", de: "Bereichs-ID" }), result.base.id],
          ];
          for (const [label, value] of rows) ctx.print(`${label}: ${value}`);
        },
      }),
      command("cat", {
        summary: t({ en: "Print a text file", de: "Eine Textdatei ausgeben" }),
        description: t({
          en: `Prints UTF-8 text up to ${CONTENT_STREAM_LIMIT / 1024 / 1024} MiB and refuses binary content; save that with --out or get.`,
          de: `Gibt UTF-8-Text bis ${CONTENT_STREAM_LIMIT / 1024 / 1024} MiB aus und verweigert Binärinhalte; speichere sie mit --out oder get.`,
        }),
        args: { file: fileArg({ en: "<area>:/path or a file ID", de: "<bereich>:/pfad oder eine Datei-ID" }) },
        flags: {
          out: flag.string({
            description: t({
              en: "Save to this new local file instead of printing",
              de: "In diese neue lokale Datei speichern statt ausgeben",
            }),
          }),
        },
        async run({ ctx, args, flags }) {
          const target = await fileResolver(ctx).file(args.file);
          const path = requireEntry(target);
          const lease = async (signal: AbortSignal) =>
            ctx.readJson<DownloadLease>(
              await api(ctx).bases[":baseId"].download.$post({ param: param(target), json: { path } }, { init: { signal } }),
            );
          if (flags.out) return saved(ctx, await downloadFile(ctx, flags.out, lease));
          const bytes = await readFile(ctx, CONTENT_STREAM_LIMIT, lease);
          let content: string;
          try {
            if (bytes.includes(0)) throw new Error();
            content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            throw new Error(
              t({
                en: "This file is not text. Save it with --out or get.",
                de: "Diese Datei ist kein Text. Speichere sie mit --out oder get.",
              }),
            );
          }
          if (!printStructured(ctx, { baseId: target.baseId, path, bytes: bytes.byteLength, content })) await ctx.write(content);
        },
      }),
      command("get", {
        summary: t({
          en: "Download a file, or a folder as ZIP, directly from Filegate",
          de: "Eine Datei oder einen Ordner als ZIP direkt von Filegate herunterladen",
        }),
        description: t({
          en: "Saves to a new local file and never overwrites. Without [local], uses the remote name in the working directory; a local folder receives the remote name.",
          de: "Speichert in eine neue lokale Datei und überschreibt nie. Ohne [local] wird der entfernte Name im Arbeitsverzeichnis verwendet; ein lokaler Ordner erhält den entfernten Namen.",
        }),
        args: {
          remote: fileArg({ en: "<area>:/path or a file ID", de: "<bereich>:/pfad oder eine Datei-ID" }),
          local: arg.optional({
            valueLabel: "local",
            description: t({ en: "New local file or existing local folder", de: "Neue lokale Datei oder bestehender lokaler Ordner" }),
          }),
        },
        examples: ["cld filesv2 get me:/Documents/report.pdf", "cld filesv2 get team:/Photos ./photos.zip"],
        async run({ ctx, args }) {
          const target = await fileResolver(ctx).file(args.remote);
          const path = requireEntry(target);
          const info = await entry(ctx, target);
          const output = await localTarget(args.local, info.entry.directory ? `${nameOf(path)}.zip` : nameOf(path));
          const result = await downloadFile(ctx, output, async (signal) =>
            info.entry.directory
              ? ctx.readJson<ArchiveDownload>(
                  await api(ctx).bases[":baseId"].archive.$post({ param: param(target), json: { paths: [path] } }, { init: { signal } }),
                )
              : ctx.readJson<DownloadLease>(
                  await api(ctx).bases[":baseId"].download.$post({ param: param(target), json: { path } }, { init: { signal } }),
                ),
          );
          saved(ctx, result);
        },
      }),
      command("zip", {
        summary: t({
          en: "Download several entries of one area as one ZIP",
          de: "Mehrere Einträge eines Bereichs als ein ZIP herunterladen",
        }),
        args: { remotes: fileArgs({ en: "Entries of one area (1-100)", de: "Einträge eines Bereichs (1-100)" }) },
        flags: {
          out: flag.string({
            required: true,
            description: t({ en: "New local ZIP file; never overwritten", de: "Neue lokale ZIP-Datei; wird nie überschrieben" }),
          }),
        },
        examples: ["cld filesv2 zip me:/Documents me:/Photos/team.jpg --out ./selection.zip"],
        async run({ ctx, args, flags }) {
          const { baseId, targets } = await fileResolver(ctx).sameArea(args.remotes);
          const paths = targets.map(requireEntry);
          const result = await downloadFile(ctx, flags.out!, async (signal) =>
            ctx.readJson<ArchiveDownload>(
              await api(ctx).bases[":baseId"].archive.$post({ param: { baseId }, json: { paths } }, { init: { signal } }),
            ),
          );
          saved(ctx, result);
        },
      }),
      command("put", {
        summary: t({ en: "Upload a local file directly to Filegate", de: "Eine lokale Datei direkt zu Filegate hochladen" }),
        description: t({
          en: "A remote ending in / (or the area root) receives the local file name. Existing files are replaced only with --replace.",
          de: "Ein Ziel mit abschließendem / (oder der Bereich selbst) erhält den lokalen Dateinamen. Bestehende Dateien werden nur mit --replace ersetzt.",
        }),
        args: {
          local: arg.required({ valueLabel: "local", description: t({ en: "Local file to upload", de: "Lokale Datei zum Hochladen" }) }),
          remote: fileArg({ en: "<area>:/path, or <area>:/folder/", de: "<bereich>:/pfad oder <bereich>:/ordner/" }),
        },
        flags: {
          parents: flag.boolean({ description: t({ en: "Create missing parent folders", de: "Fehlende übergeordnete Ordner anlegen" }) }),
          replace: flag.boolean({ description: t({ en: "Replace an existing file", de: "Eine bestehende Datei ersetzen" }) }),
          expectedRevision: flag.string({
            description: t({ en: "Only replace this revision (from stat)", de: "Nur diese Revision ersetzen (aus stat)" }),
          }),
        },
        examples: ["cld filesv2 put ./report.pdf me:/Documents/", "cld filesv2 put ./report.pdf team:/2026/Q3/report.pdf --parents"],
        async run({ ctx, args, flags }) {
          const target = await fileResolver(ctx).file(args.remote);
          const path = target.folder ? joinPath(target.path, basename(args.local)) : target.path;
          if (flags.parents && parentOf(path)) await mkdirParents(ctx, target.baseId, parentOf(path));
          const baseParam = param(target);
          const result = await uploadFile(ctx, args.local, {
            scope: JSON.stringify([ctx.options.profile, target.baseId, path, flags.replace, flags.expectedRevision]),
            open: async (size, signal, idempotencyKey) =>
              ctx.readJson<UploadSession>(
                await api(ctx).bases[":baseId"].uploads.$post(
                  {
                    param: baseParam,
                    json: {
                      path,
                      size,
                      expectedRevision: flags.expectedRevision,
                      onConflict: flags.replace ? "overwrite" : "error",
                      idempotencyKey,
                    },
                  },
                  { init: { signal } },
                ),
              ),
            renew: async (id, signal) =>
              ctx.readJson<UploadLease>(
                await api(ctx).bases[":baseId"].uploads[":id"].lease.$post({ param: { ...baseParam, id } }, { init: { signal } }),
              ),
            commit: async (id, signal) =>
              ctx.readJson<EntryResult>(
                await api(ctx).bases[":baseId"].uploads[":id"].commit.$post({ param: { ...baseParam, id } }, { init: { signal } }),
              ),
            abort: async (id, signal) => {
              await api(ctx).bases[":baseId"].uploads[":id"].abort.$post({ param: { ...baseParam, id } }, { init: { signal } });
            },
          });
          if (!printStructured(ctx, result))
            ctx.print(
              `${t({ en: "Uploaded", de: "Hochgeladen" })}: ${addressOf(result.base, result.entry.path)} (${result.entry.size} bytes)`,
            );
        },
      }),
      command("mkdir", {
        summary: t({ en: "Create a folder", de: "Einen Ordner anlegen" }),
        args: {
          folder: arg.required({
            valueLabel: "folder",
            description: t({ en: "<area>:/path of the new folder", de: "<bereich>:/pfad des neuen Ordners" }),
          }),
        },
        flags: {
          parents: flag.boolean({
            aliases: ["p"],
            description: t({
              en: "Create missing parents; an existing folder is no error",
              de: "Fehlende Eltern anlegen; ein bestehender Ordner ist kein Fehler",
            }),
          }),
        },
        examples: ["cld filesv2 mkdir -p me:/Documents/2026/Q3"],
        async run({ ctx, args, flags }) {
          const target = await fileResolver(ctx).file(args.folder);
          const path = requireEntry(target);
          const result = flags.parents ? (await mkdirParents(ctx, target.baseId, path))! : await mkdir(ctx, target.baseId, path);
          if (!printStructured(ctx, result))
            ctx.print(`${t({ en: "Created", de: "Angelegt" })}: ${addressOf(result.base, result.entry.path)}`);
        },
      }),
      command("mv", {
        summary: t({
          en: "Rename an entry, or move entries into a folder of the same area",
          de: "Einen Eintrag umbenennen oder Einträge in einen Ordner desselben Bereichs verschieben",
        }),
        description: t({
          en: "The last address is the destination. An existing folder, a trailing / or several sources move into that folder. Otherwise the single source is renamed in its folder. mv never overwrites and never crosses areas; use cp and rm for that.",
          de: "Die letzte Adresse ist das Ziel. Ein bestehender Ordner, ein abschließendes / oder mehrere Quellen verschieben in diesen Ordner. Sonst wird die einzelne Quelle in ihrem Ordner umbenannt. mv überschreibt nie und wechselt nie den Bereich; nutze dafür cp und rm.",
        }),
        args: { paths: fileArgs({ en: "Sources, then the destination", de: "Quellen, dann das Ziel" }) },
        examples: ["cld filesv2 mv me:/Documents/draft.txt me:/Documents/final.txt", "cld filesv2 mv me:/a.txt me:/b.txt me:/Archive/"],
        async run({ ctx, args }) {
          if (args.paths.length < 2)
            throw new Error(t({ en: "Pass at least one source and a destination.", de: "Gib mindestens eine Quelle und ein Ziel an." }));
          const files = fileResolver(ctx);
          const { baseId, targets } = await files.sameArea(args.paths.slice(0, -1));
          const destination = await files.file(args.paths.at(-1)!);
          if (destination.baseId !== baseId)
            throw new Error(
              t({ en: "mv stays inside one area. Use cp and then rm.", de: "mv bleibt in einem Bereich. Nutze cp und danach rm." }),
            );
          const sources = targets.map(requireEntry);
          const existing = destination.folder || sources.length > 1 ? null : await entryOrNull(ctx, destination);
          if (destination.folder || sources.length > 1 || existing?.entry.directory) {
            const result = await ctx.readJson<EntriesResult>(
              await api(ctx).bases[":baseId"].move.$post({ param: { baseId }, json: { paths: sources, folder: destination.path } }),
            );
            return batch(ctx, result);
          }
          if (existing)
            throw new Error(
              t({
                en: "409 The destination already exists; mv never overwrites.",
                de: "409 Das Ziel existiert bereits; mv überschreibt nie.",
              }),
            );
          const [source] = sources as [string];
          if (parentOf(source) !== parentOf(destination.path))
            throw new Error(
              t({
                en: "mv renames within one folder or moves into a folder. Move first, then rename.",
                de: "mv benennt innerhalb eines Ordners um oder verschiebt in einen Ordner. Verschiebe zuerst und benenne dann um.",
              }),
            );
          const renamed = await ctx.readJson<EntryResult>(
            await api(ctx).bases[":baseId"].rename.$post({ param: { baseId }, json: { path: source, name: nameOf(destination.path) } }),
          );
          const result: EntriesResult = {
            base: renamed.base,
            entries: [renamed.entry],
            results: [{ path: source, ok: true, entry: renamed.entry }],
          };
          return batch(ctx, result);
        },
      }),
      command("cp", {
        summary: t({
          en: "Copy entries into a folder of this or another area",
          de: "Einträge in einen Ordner dieses oder eines anderen Bereichs kopieren",
        }),
        description: t({
          en: "The last address is the destination folder; copies keep their names.",
          de: "Die letzte Adresse ist der Zielordner; Kopien behalten ihren Namen.",
        }),
        args: {
          paths: fileArgs({ en: "Sources of one area, then the destination folder", de: "Quellen eines Bereichs, dann der Zielordner" }),
        },
        examples: ["cld filesv2 cp me:/Documents/report.pdf team:/Shared/"],
        async run({ ctx, args }) {
          if (args.paths.length < 2)
            throw new Error(t({ en: "Pass at least one source and a destination.", de: "Gib mindestens eine Quelle und ein Ziel an." }));
          const files = fileResolver(ctx);
          const { baseId, targets } = await files.sameArea(args.paths.slice(0, -1));
          const destination = await files.file(args.paths.at(-1)!);
          const result = await ctx.readJson<EntriesResult>(
            await api(ctx).bases[":baseId"].copy.$post({
              param: { baseId },
              json: { paths: targets.map(requireEntry), targetBaseId: destination.baseId, folder: destination.path },
            }),
          );
          return batch(ctx, result);
        },
      }),
      command("rm", {
        summary: t({ en: "Move entries to their area's trash", de: "Einträge in den Papierkorb ihres Bereichs verschieben" }),
        description: t({ en: "Entries stay restorable with trash restore.", de: "Einträge bleiben mit trash restore wiederherstellbar." }),
        args: { paths: fileArgs({ en: "Entries of one area", de: "Einträge eines Bereichs" }) },
        flags: { yes },
        examples: ["cld filesv2 rm me:/Documents/old.txt --yes"],
        async run({ ctx, args, flags }) {
          requireYes(flags.yes);
          const { baseId, targets } = await fileResolver(ctx).sameArea(args.paths);
          const result = await ctx.readJson<{
            entries: TrashEntry[];
            results: ({ path: string; ok: true; entry: TrashEntry } | { path: string; ok: false; error: string })[];
          }>(await api(ctx).bases[":baseId"].delete.$post({ param: { baseId }, json: { paths: targets.map(requireEntry) } }));
          return batch(ctx, result);
        },
      }),
      command("search", {
        summary: t({ en: "Search names below a folder", de: "Namen unterhalb eines Ordners suchen" }),
        args: {
          folder: arg.required({
            valueLabel: "folder",
            description: t({ en: "<area>:/path to search below", de: "<bereich>:/pfad, unterhalb dessen gesucht wird" }),
          }),
          query: arg.required({ description: t({ en: "Name fragment", de: "Namensbestandteil" }) }),
        },
        flags: {
          scope: flag.enum(["tree", "folder"], {
            default: "tree",
            description: t({
              en: "tree searches all levels below the folder, folder only its direct entries",
              de: "tree durchsucht alle Ebenen unter dem Ordner, folder nur seine direkten Einträge",
            }),
          }),
          after,
          ...browseFlags,
        },
        examples: ["cld filesv2 search me:/Documents report"],
        async run({ ctx, args, flags }) {
          const target = await fileResolver(ctx).file(args.folder);
          const result = await ctx.readJson<SearchResult>(
            await api(ctx).bases[":baseId"].search.$get({
              param: param(target),
              query: { q: args.query, path: target.path, scope: flags.scope ?? "tree", after: flags.after, ...browseQuery(flags) },
            }),
          );
          entryRows(ctx, result, result.items, "path");
          next(ctx, result.next);
        },
      }),
      command("trash list", {
        summary: t({ en: "List an area's trash", de: "Den Papierkorb eines Bereichs auflisten" }),
        args: { area: areaArg },
        flags: { after },
        async run({ ctx, args, flags }) {
          const baseId = await fileResolver(ctx).area(args.area);
          const result = await ctx.readJson<{ entries: TrashEntry[]; next: string | null }>(
            await api(ctx).bases[":baseId"].trash.$get({ param: { baseId }, query: { after: flags.after } }),
          );
          printRows(ctx, ctx.options.output === "jsonl" ? result.entries : result, result.entries, [
            { key: "id", label: "ID" },
            { key: "original", label: t({ en: "Original path", de: "Ursprünglicher Pfad" }) },
            { key: "deletedAt", label: t({ en: "Deleted", de: "Gelöscht" }) },
          ]);
          next(ctx, result.next);
        },
      }),
      command("trash restore", {
        summary: t({ en: "Restore a trashed entry", de: "Einen Eintrag aus dem Papierkorb wiederherstellen" }),
        args: { area: areaArg, id: arg.required({ description: t({ en: "Trash entry ID", de: "Papierkorb-ID" }) }) },
        flags: {
          to: flag.string({
            valueLabel: "path",
            description: t({
              en: "Destination path in the same area; required when the original path is unknown",
              de: "Zielpfad im selben Bereich; nötig, wenn der ursprüngliche Pfad unbekannt ist",
            }),
          }),
        },
        async run({ ctx, args, flags }) {
          const baseId = await fileResolver(ctx).area(args.area);
          const result = await ctx.readJson<EntryResult>(
            await api(ctx).bases[":baseId"].trash[":id"].restore.$post({
              param: { baseId, id: args.id },
              query: { path: flags.to?.replace(/^\/+/, "") },
            }),
          );
          if (!printStructured(ctx, result))
            ctx.print(`${t({ en: "Restored", de: "Wiederhergestellt" })}: ${addressOf(result.base, result.entry.path)}`);
        },
      }),
      command("versions list", {
        summary: t({ en: "List a file's versions", de: "Die Versionen einer Datei auflisten" }),
        args: { file: fileArg({ en: "<area>:/path or a file ID", de: "<bereich>:/pfad oder eine Datei-ID" }) },
        async run({ ctx, args }) {
          const target = await fileResolver(ctx).file(args.file);
          const result = await ctx.readJson<FileVersion[]>(
            await api(ctx).bases[":baseId"].versions.$get({ param: param(target), query: { path: requireEntry(target) } }),
          );
          printRows(ctx, result, result, [
            { key: "id", label: "ID" },
            { key: "created", label: t({ en: "Created", de: "Erstellt" }) },
            { key: "size", label: "Bytes" },
            { key: "comment", label: t({ en: "Comment", de: "Kommentar" }) },
          ]);
        },
      }),
      command("versions get", {
        summary: t({
          en: "Download one historical version directly from Filegate",
          de: "Eine frühere Version direkt von Filegate herunterladen",
        }),
        args: {
          file: fileArg({ en: "<area>:/path or a file ID", de: "<bereich>:/pfad oder eine Datei-ID" }),
          id: arg.required({ valueLabel: "version", description: t({ en: "Version ID", de: "Versions-ID" }) }),
          local: arg.required({
            valueLabel: "local",
            description: t({ en: "New local file or existing local folder", de: "Neue lokale Datei oder bestehender lokaler Ordner" }),
          }),
        },
        examples: ["cld filesv2 versions get me:/Documents/report.pdf <version-id> ./report-v1.pdf"],
        async run({ ctx, args }) {
          const target = await fileResolver(ctx).file(args.file);
          const path = requireEntry(target);
          const output = await localTarget(args.local, nameOf(path));
          saved(
            ctx,
            await downloadFile(ctx, output, async (signal) =>
              ctx.readJson<DownloadLease>(
                await api(ctx).bases[":baseId"].versions.download.$post(
                  { param: param(target), json: { path, id: args.id } },
                  { init: { signal } },
                ),
              ),
            ),
          );
        },
      }),
      command("versions restore", {
        summary: t({
          en: "Restore a version in place or as a new file",
          de: "Eine Version an Ort und Stelle oder als neue Datei wiederherstellen",
        }),
        args: {
          file: fileArg({ en: "<area>:/path or a file ID", de: "<bereich>:/pfad oder eine Datei-ID" }),
          id: arg.required({ valueLabel: "version", description: t({ en: "Version ID", de: "Versions-ID" }) }),
        },
        flags: {
          as: flag.string({
            valueLabel: "name",
            description: t({ en: "Restore as a new file with this name", de: "Als neue Datei mit diesem Namen wiederherstellen" }),
          }),
        },
        async run({ ctx, args, flags }) {
          const target = await fileResolver(ctx).file(args.file);
          const path = requireEntry(target);
          const result = await ctx.readJson<EntryResult>(
            flags.as
              ? await api(ctx).bases[":baseId"].versions["restore-as"].$post({
                  param: param(target),
                  json: { path, id: args.id, name: flags.as },
                })
              : await api(ctx).bases[":baseId"].versions.restore.$post({ param: param(target), json: { path, id: args.id } }),
          );
          if (!printStructured(ctx, result))
            ctx.print(`${t({ en: "Restored", de: "Wiederhergestellt" })}: ${addressOf(result.base, result.entry.path)}`);
        },
      }),
      command("versions update", {
        summary: t({ en: "Set a version's comment", de: "Den Kommentar einer Version setzen" }),
        args: {
          file: fileArg({ en: "<area>:/path or a file ID", de: "<bereich>:/pfad oder eine Datei-ID" }),
          id: arg.required({ valueLabel: "version", description: t({ en: "Version ID", de: "Versions-ID" }) }),
        },
        flags: {
          comment: flag.string({
            required: true,
            description: t({ en: "Comment text; empty clears it", de: "Kommentartext; leer entfernt ihn" }),
          }),
        },
        async run({ ctx, args, flags }) {
          const target = await fileResolver(ctx).file(args.file);
          const result = await ctx.readJson<FileVersion>(
            await api(ctx).bases[":baseId"].versions.comment.$post({
              param: param(target),
              json: { path: requireEntry(target), id: args.id, comment: flags.comment! },
            }),
          );
          if (!printStructured(ctx, result)) ctx.print(`${result.id}: ${result.comment ?? ""}`);
        },
      }),
      command("shares list", {
        summary: t({ en: "List your public links and inboxes", de: "Deine öffentlichen Links und Eingänge auflisten" }),
        flags: { after },
        async run({ ctx, flags }) {
          const result = await ctx.readJson<SharePage>(await api(ctx).shares.$get({ query: { after: flags.after } }));
          printRows(ctx, ctx.options.output === "jsonl" ? result.items : result, result.items, [
            { key: "id", label: "ID" },
            { key: "kind", label: t({ en: "Kind", de: "Art" }) },
            { key: "title", label: t({ en: "Name", de: "Name" }) },
            { key: "state", label: "Status" },
            { key: "expiresAt", label: t({ en: "Expires", de: "Läuft ab" }) },
          ]);
          next(ctx, result.next);
        },
      }),
      command("shares add", {
        summary: t({
          en: "Create a public download link or an upload inbox",
          de: "Öffentlichen Download-Link oder Upload-Eingang erstellen",
        }),
        description: t({
          en: "Prints the public URL once; it cannot be shown again. Read a password with --password-file, never from an argument.",
          de: "Gibt die öffentliche URL einmalig aus; sie ist später nicht mehr abrufbar. Lies ein Passwort mit --password-file, nie aus einem Argument.",
        }),
        args: {
          paths: fileArgs({
            en: "Entries of one area (download) or one folder (inbox)",
            de: "Einträge eines Bereichs (Download) oder ein Ordner (Eingang)",
          }),
        },
        flags: {
          kind: flag.enum(["download", "inbox"], {
            default: "download",
            description: t({ en: "download or inbox", de: "download oder inbox" }),
          }),
          title: flag.string({ required: true, description: t({ en: "Name shown to visitors", de: "Name, den Besucher sehen" }) }),
          "expires-in": flag.enum(["1d", "7d", "30d", "90d", "unlimited"], {
            default: "30d",
            description: t({ en: "Link lifetime", de: "Gültigkeit des Links" }),
          }),
          note: flag.string({ description: t({ en: "Private management note", de: "Private Verwaltungsnotiz" }) }),
          "password-file": flag.string({
            description: t({
              en: "Read an optional share password from a private UTF-8 file",
              de: "Optionales Freigabe-Passwort aus einer privaten UTF-8-Datei lesen",
            }),
          }),
          "public-note": flag.string({ description: t({ en: "Public note for visitors", de: "Öffentlicher Hinweis für Besucher" }) }),
          "max-file-size": flag.int({
            default: 104857600,
            description: t({ en: "Inbox limit per file in bytes", de: "Eingangslimit pro Datei in Bytes" }),
          }),
          "max-total-size": flag.int({
            default: 1073741824,
            description: t({ en: "Cumulative inbox limit in bytes", de: "Kumulatives Eingangslimit in Bytes" }),
          }),
          "show-upload-names": flag.boolean({
            description: t({
              en: "Show names of successful inbox uploads to visitors",
              de: "Namen erfolgreicher Eingangs-Uploads für Besucher anzeigen",
            }),
          }),
        },
        examples: [
          'cld filesv2 shares add me:/Documents/report.pdf --title "Report" --expires-in 7d',
          'cld filesv2 shares add team:/Incoming --kind inbox --title "Send files"',
        ],
        async run({ ctx, args, flags }) {
          const kind = flags.kind ?? "download";
          if (kind === "inbox" && args.paths.length !== 1)
            throw new Error(t({ en: "An inbox shares exactly one folder.", de: "Ein Eingang teilt genau einen Ordner." }));
          const { baseId, targets } = await fileResolver(ctx).sameArea(args.paths);
          const passwordFile = flags["password-file"] ? Bun.file(flags["password-file"]) : null;
          if (passwordFile && passwordFile.size > 2048)
            throw new Error(t({ en: "Password file is too large.", de: "Die Passwortdatei ist zu groß." }));
          const password = passwordFile ? (await passwordFile.text()).replace(/\r?\n$/, "") : undefined;
          const result = await ctx.readJson<ShareView>(
            await api(ctx).bases[":baseId"].shares.$post({
              param: { baseId },
              json: {
                kind,
                paths: kind === "download" ? targets.map(requireEntry) : [],
                folder: kind === "inbox" ? targets[0]!.path : "",
                title: flags.title!,
                note: flags.note,
                publicNote: flags["public-note"],
                expiresIn: flags["expires-in"],
                maxFileSize: flags["max-file-size"],
                maxTotalSize: flags["max-total-size"],
                showUploadNames: flags["show-upload-names"],
                password,
              },
            }),
          );
          if (!printStructured(ctx, result)) ctx.print(result.url ?? "");
        },
      }),
      command("shares rm", {
        summary: t({ en: "Revoke a public link or inbox", de: "Öffentlichen Link oder Eingang widerrufen" }),
        description: t({
          en: "The link stops working at once and stays listed as revoked.",
          de: "Der Link funktioniert sofort nicht mehr und bleibt als widerrufen gelistet.",
        }),
        args: { id: arg.required({ description: t({ en: "Share ID from shares list", de: "Freigabe-ID aus shares list" }) }) },
        flags: { yes },
        async run({ ctx, args, flags }) {
          requireYes(flags.yes);
          const result = await ctx.readJson<ShareView>(await api(ctx).shares[":id"].revoke.$post({ param: { id: args.id } }));
          if (!printStructured(ctx, result)) ctx.print(`${result.title}: ${result.state}`);
        },
      }),
      command("recent", {
        summary: t({ en: "List recently opened entries", de: "Zuletzt geöffnete Einträge auflisten" }),
        async run({ ctx }) {
          markedRows(ctx, await ctx.readJson<MarkedEntry[]>(await api(ctx).recent.$get()), { en: "Opened", de: "Geöffnet" });
        },
      }),
      command("favorites list", {
        summary: t({ en: "List favorite entries", de: "Favoriten auflisten" }),
        async run({ ctx }) {
          markedRows(ctx, await ctx.readJson<MarkedEntry[]>(await api(ctx).favorites.$get()), { en: "Marked", de: "Markiert" });
        },
      }),
      ...([true, false] as const).map((favorite) =>
        command(favorite ? "favorites add" : "favorites remove", {
          summary: favorite
            ? t({ en: "Mark an entry as favorite", de: "Eintrag als Favorit markieren" })
            : t({ en: "Remove an entry from the favorites", de: "Eintrag aus den Favoriten entfernen" }),
          args: { file: fileArg({ en: "<area>:/path or a file ID", de: "<bereich>:/pfad oder eine Datei-ID" }) },
          async run({ ctx, args }) {
            const target = await fileResolver(ctx).file(args.file);
            const result = await ctx.readJson<{ favorite: boolean }>(
              await api(ctx).bases[":baseId"].favorite.$post({ param: param(target), json: { path: requireEntry(target), favorite } }),
            );
            if (!printStructured(ctx, result))
              ctx.print(
                `${favorite ? t({ en: "Favorite", de: "Favorit" }) : t({ en: "Removed from favorites", de: "Aus Favoriten entfernt" })}: ${args.file}`,
              );
          },
        }),
      ),
      command("documents create", {
        summary: t({ en: "Create an empty document for the browser editors", de: "Leeres Dokument für die Browser-Editoren anlegen" }),
        description: t({
          en: "Office kinds need Collabora and append the configured format's extension to a path without one. markdown needs a .md path.",
          de: "Office-Arten brauchen Collabora und hängen die Endung des konfigurierten Formats an einen Pfad ohne Endung an. markdown braucht einen .md-Pfad.",
        }),
        args: { file: fileArg({ en: "<area>:/path of the new document", de: "<bereich>:/pfad des neuen Dokuments" }) },
        flags: {
          kind: flag.enum([...DOCUMENT_KINDS, "markdown"], {
            default: "text",
            description: t({ en: "text, spreadsheet, presentation or markdown", de: "text, spreadsheet, presentation oder markdown" }),
          }),
        },
        examples: [
          "cld filesv2 documents create me:/Documents/Minutes --kind text",
          "cld filesv2 documents create me:/Notes.md --kind markdown",
        ],
        async run({ ctx, args, flags }) {
          const target = await fileResolver(ctx).file(args.file);
          const path = requireEntry(target);
          const kind = flags.kind ?? "text";
          const result = await ctx.readJson<EntryResult>(
            kind === "markdown"
              ? await api(ctx).bases[":baseId"].markdown.$post({ param: param(target), json: { path } })
              : await api(ctx).bases[":baseId"].documents.$post({ param: param(target), json: { path, kind } }),
          );
          if (!printStructured(ctx, result))
            ctx.print(`${t({ en: "Created", de: "Angelegt" })}: ${addressOf(result.base, result.entry.path)}`);
        },
      }),
      command("edit-url", {
        summary: t({
          en: "Print the browser address that opens a file in the editor",
          de: "Browser-Adresse ausgeben, die eine Datei im Editor öffnet",
        }),
        args: { file: fileArg({ en: "<area>:/path or a file ID", de: "<bereich>:/pfad oder eine Datei-ID" }) },
        async run({ ctx, args }) {
          const target = await fileResolver(ctx).file(args.file);
          const url = new URL(editorUrl(target.baseId, requireEntry(target)), ctx.options.server).href;
          if (!printStructured(ctx, { url })) ctx.print(url);
        },
      }),
      command("thumbnail", {
        summary: t({
          en: "Save a generated image preview directly from Filegate",
          de: "Eine generierte Bildvorschau direkt von Filegate speichern",
        }),
        args: {
          file: fileArg({ en: "<area>:/path of an image", de: "<bereich>:/pfad eines Bildes" }),
          local: arg.required({ valueLabel: "local", description: t({ en: "New local file", de: "Neue lokale Datei" }) }),
        },
        flags: {
          size: flag.enum(["small", "large"], {
            default: "small",
            description: t({ en: "small (320 px) or large (1024 px)", de: "small (320 px) oder large (1024 px)" }),
          }),
        },
        async run({ ctx, args, flags }) {
          const target = await fileResolver(ctx).file(args.file);
          const path = requireEntry(target);
          saved(
            ctx,
            await downloadFile(ctx, args.local, async (signal) =>
              ctx.readJson<DownloadLease>(
                await api(ctx).bases[":baseId"].thumbnail.$post(
                  { param: param(target), json: { path, size: flags.size } },
                  { init: { signal } },
                ),
              ),
            ),
          );
        },
      }),
      ...templateCommands(locale),
      ...adminCommands(locale),
    ],
  });
}

const module = filesCommands();
export default {
  ...module,
  help: (locale?: string) => filesCommands(locale).help!(),
  run: (ctx: CloudCliContext) => filesCommands(ctx.options.locale).run(ctx),
};
