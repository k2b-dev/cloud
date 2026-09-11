import { database, DatabaseError } from "./service/database";
import { DatabaseCall, DatabaseRequest, DatabaseSql } from "./database-contracts";
import { databaseErrorMessage, databaseMessages } from "./database-messages";
import { z } from "zod";
import { ok, fail, i18n } from "@k2b/stdlib";
import {
  defineCapabilities,
  UniversalSearchInputSchema,
  UniversalSearchDataSchema,
  type CapabilityExecutionContext,
  type CapabilityResult,
  type CloudResourceView,
} from "@k2b/cloud/contracts";
import { projects, ProjectError, user } from "./service";
import { AppId, CreateAppInput, UpdateAppInput, SourceChangeInput, SourceReadInput, SOURCE_WINDOW } from "./source";
import { apiErrorMessage, ProjectValidationError } from "./errors";
import { LIMITS, PublicId } from "./contracts";

const [tablesList, tablesCreate, tablesUpdate, tablesDelete, schemaGet, rowsList, rowsGet, rowsInsert, rowsUpdate, rowsDelete] = DatabaseRequest.options;

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      create: "Create this Kit app. It will not start automatically.",
      update: "Update this app. Disabling its database preserves all data.",
      settings: "Settings",
      apply: "Save these source changes. The app will run only when you start it.",
      app: "App",
      revision: "Revision",
      files: "Changed files",
      saved: "Saved source changes",
      sqlFailed: "The read query failed. Check the SQL, table names and columns.",
      invalid: "Check the source changes and file paths.",
    },
    de: {
      create: "Diese Kit-App erstellen. Sie startet nicht automatisch.",
      update: "Diese App ändern. Das Deaktivieren der Datenbank erhält alle Daten.",
      settings: "Einstellungen",
      sqlFailed: "Die Leseabfrage ist fehlgeschlagen. Prüfe SQL, Tabellennamen und Spalten.",
      apply: "Diese Quelltextänderungen speichern. Die App läuft erst, wenn du sie startest.",
      app: "App",
      revision: "Revision",
      files: "Geänderte Dateien",
      saved: "Quelltextänderungen gespeichert",
      invalid: "Prüfe die Quelltextänderungen und Dateipfade.",
    },
  },
});
const entry = z.object({ path: z.string(), name: z.string(), icon: z.string(), order: z.number() }).strict();
const appManifest = z
        .object({
          id: PublicId,
          name: z.string(),
          description: z.string(),
          persistenceEnabled: z.boolean(),
          revision: z.number().int(),
          sdkVersion: z.number().int(),
          updatedAt: z.string(),
          permission: z.enum(["none", "read", "write", "admin"]),
          entries: z.array(entry).max(LIMITS.files),
          files: z.array(z.object({ path: z.string(), length: z.number().int(), bytes: z.number().int() }).strict()).max(LIMITS.files),
        })
        .strict();
const appLifecycleResult = appManifest.extend({ database: z.object({ enabled: z.boolean(), globallyEnabled: z.boolean(), provisioned: z.boolean(), generation: z.number().int(), status: z.string(), canAdmin: z.boolean(), error: z.string().nullable() }) });
const identity = (id: string) => ({ refs: [{ type: "kit.app", id }], links: [{ rel: "open" as const, href: `/app/kit/${id}` }] });
async function result<T>(context: CapabilityExecutionContext, operation: () => Promise<CapabilityResult<T>>, readOnly = false) {
  try {
    return ok(await operation());
  } catch (e) {
    if (e instanceof DatabaseError)
      return fail({ code: e.code, status: e.status === 502 ? 500 : e.status, message: readOnly && databaseErrorMessage(e.code, context.locale) === databaseMessages.resolve([context.locale]).t.request ? messages.resolve([context.locale]).t.sqlFailed : databaseErrorMessage(e.code, context.locale) });
    if (e instanceof ProjectError) return fail({ code: e.code, status: e.status, message: apiErrorMessage(e.code, context.locale) });
    if (e instanceof ProjectValidationError)
      return fail({ code: "INVALID_PROJECT", status: 400 as const, message: e.localized(context.locale) });
    if (e instanceof z.ZodError)
      return fail({ code: "INVALID_INPUT", status: 400 as const, message: messages.resolve([context.locale]).t.invalid });
    throw e;
  }
}
const sourceInputDe = {
  id: "Sechsstellige App-ID aus einer kit.app-Referenz oder Kit-URL.",
  expectedRevision: "Exakte Revision aus kit.app.read; nicht selbst erhöhen.",
  upsert: "Vollständige neue oder ersetzte Dateien. Nicht genannte Dateien bleiben erhalten.",
  "upsert[].path": "Relativer .js- oder .md-Dateipfad zum Anlegen oder vollständigen Ersetzen.",
  "upsert[].content": "Vollständiger Quelltext. Vor dem Ersetzen die ganze bisherige Datei lesen.",
  delete: "Exakte zu löschende Pfade; Imports im selben Änderungssatz anpassen.",
  edits: "Ein Bereich pro bestehender Datei; jeder Pfad darf nur einmal vorkommen.",
  "edits[].path": "Bestehende Datei für eine gezielte Änderung.",
  "edits[].offset": "UTF-16-Startposition in der angegebenen Revision.",
  "edits[].deleteCount": "Anzahl zu ersetzender UTF-16-Einheiten; null Einheiten fügt ein.",
  "edits[].content": "Einzufügender Quelltext; große Dateien gezielt ändern.",
};
const changed = z
  .object({ id: PublicId, revision: z.number().int(), entries: z.array(entry).max(LIMITS.files), valid: z.boolean() })
  .strict();
const changeDescription =
  "Check or save one batch against expectedRevision. Preserve omitted files. Use range edits for large files; requests including JSON must fit 256 KiB. Never replace a file from a partial read.";

export const kitCapabilities = defineCapabilities({
  protocolVersion: 1,
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        types: { app: { title: "Kit-App", description: "Eine Kit-App mit lokal ausgeführten Werkzeugen." } },
        queries: {
          "database.status": {
            title: "Kit-Datenbankstatus lesen",
            description: "Aktivierung, Generation und Diagnose lesen, ohne eine Datenbank zu aktivieren.",
          },
          "database.read": {
            title: "Kit-Datenbank lesen",
            description: "Mit tables.list Tabellen finden, mit schema.get und exaktem Tabellennamen das Schema lesen. Auch Datensätze lesen; für SELECT database.sql verwenden; aktuelle Generation aus database.status verwenden.",
          },
          "database.sql": {
            title: "Kit-Datenbank mit SQL abfragen",
            description: "Eine lesende SELECT-Abfrage für Filter, Joins oder Auswertungen ausführen. Generation aus database.status, Schema über database.read holen. Werte mit ? und params binden. Maximal 1000 Zeilen; keine Schreiboperationen, CTEs, Kommentare oder mehreren Statements.",
          },
          "app.search": {
            title: "Kit-Apps suchen",
            input: {
              query: "Suchtext für Name oder Beschreibung.",
              tags: "Unterstützte Suchfacetten; kit für Kit-Apps.",
              limit: "Maximale Anzahl an Ergebnissen.",
            },
            description: "Zugängliche Apps anhand von Name oder Beschreibung finden. Zurückgegebene Referenzen mit app.read lesen.",
          },
          "app.read": {
            title: "Kit-App lesen",
            input: { id: sourceInputDe.id },
            description: "Metadaten, Berechtigung, Revision und Dateiverzeichnis einer App lesen. Quelltext separat mit source.read laden.",
          },
          "source.read": {
            title: "Kit-Quelltext lesen",
            input: {
              id: sourceInputDe.id,
              expectedRevision: sourceInputDe.expectedRevision,
              path: "Exakter Pfad aus kit.app.read.",
              offset: "UTF-16-Position; mit null beginnen und nextOffset folgen.",
            },
            description: "Einen Quelltextabschnitt einer bestimmten Revision lesen. Bis complete mit nextOffset fortsetzen.",
          },
          "source.validate": {
            title: "Kit-Änderungen prüfen",
            input: sourceInputDe,
            description: "Änderungen an einer Revision ohne Speichern oder Ausführen prüfen. Nicht genannte Dateien bleiben erhalten.",
          },
        },
        actions: {
          "app.create": { title: "Kit-App erstellen", description: "Neue App mit Name, Beschreibung und optionaler gemeinsamer Datenbank erstellen. Liefert App-ID und Revision; danach source.apply verwenden. Kein automatischer Start." },
          "app.update": { title: "Kit-App ändern", description: "Als App-Admin Name, Beschreibung oder Datenbank-Aktivierung ändern. Exakte Revision verwenden; deaktivierte Datenbanken behalten ihre Daten." },
          "database.write": {
            title: "Kit-Datenbank ändern",
            description:
              "Schema als Admin oder Datensätze mit Use ändern. Die Datenbank muss bereits aktiviert sein; unklare Schreibausgänge werden nicht wiederholt.",
          },
          "source.apply": {
            title: "Kit-Quelltext speichern",
            input: sourceInputDe,
            description:
              "Dateien atomar hinzufügen, ändern oder löschen. App-Metadaten und Freigaben bleiben erhalten; kein automatischer Start.",
          },
        },
      },
    },
  },
  types: { app: { title: "Kit app", description: "A Kit app with locally executed tools.", icon: "ti ti-code", reader: "app.read" } },
  queries: {
    "database.status": {
      title: "Read Kit database status",
      description: "Read activation, generation and diagnostics. Use this before database operations. Does not enable a database.",
      input: z.object({ id: AppId }).strict(),
      data: z.unknown(),
      openWorld: false,
      run: ({ id }, context) => result(context, async () => ({ data: await database.status(id, context, true), ...identity(id) })),
    },
    "database.read": {
      title: "Read Kit database",
      description:
        "Inspect database structure with tables.list, then schema.get and an exact table name. Also reads rows. Use database.sql for SELECT queries. Use the exact generation from database.status. No network or namespace choice.",
      input: DatabaseCall.extend({
        id: AppId,
        request: z.discriminatedUnion("operation", [tablesList, schemaGet, rowsList, rowsGet]).describe("One structured read operation; use database.sql for SELECT."),
      }),
      data: z.unknown(),
      openWorld: false,
      run: ({ id, generation, request }, context) =>
        result(context, async () => ({ data: await database.call(id, generation, request, context), ...identity(id) }), true),
    },
    "database.sql": {
      title: "Query Kit database with SQL",
      description: "Run one read-only SELECT for filtering, joins or aggregates. Read database.status for the exact generation and database.read for schema first. Bind values with ? and params. Up to 1000 rows; narrow results with LIMIT/OFFSET. No writes, CTEs, comments or multiple statements.",
      input: DatabaseCall.omit({ request: true }).extend({ id: AppId, ...DatabaseSql.shape }),
      data: z.unknown(),
      openWorld: false,
      run: ({ id, generation, sql, params }, context) =>
        result(context, async () => ({ data: await database.call(id, generation, { operation: "query", sql, params }, context), ...identity(id) }), true),
    },
    "app.search": {
      title: "Search Kit apps",
      description: "Find accessible apps by name or description when the ID is unknown. Read returned kit.app refs using app.read.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: { tags: [{ tag: "kit", title: "Kit", description: "Browser tools and mini apps", aliases: ["tool", "script"] }] },
      run: (input, context) =>
        result(context, async () => {
          const found = await projects.list(context, 1, input.query);
          const data: CloudResourceView[] = found.items.slice(0, input.limit).map((app) => ({
            ref: { type: "kit.app", id: app.id },
            title: app.name,
            preview: app.description || undefined,
            icon: "ti ti-code",
            links: [{ rel: "open", href: `/app/kit/${app.id}` }],
          }));
          return { data };
        }),
    },
    "app.read": {
      title: "Read Kit app",
      description: "Read metadata, permission, revision and file manifest for a known app. Read source separately using source.read.",
      input: z.object({ id: AppId }).strict(),
      openWorld: false,
      data: appManifest,
      run: ({ id }, context) => result(context, async () => ({ data: await projects.manifest(id, context), ...identity(id) })),
    },
    "source.read": {
      title: "Read Kit source",
      description:
        "Read a file window at one exact revision (Use permission required). Continue with nextOffset until complete; offsets count UTF-16 units.",
      input: SourceReadInput,
      openWorld: false,
      data: z
        .object({
          id: PublicId,
          path: z.string(),
          revision: z.number().int(),
          offset: z.number().int(),
          content: z.string().max(SOURCE_WINDOW),
          length: z.number().int(),
          complete: z.boolean(),
          nextOffset: z.number().int().nullable(),
        })
        .strict(),
      run: (input, context) => result(context, async () => ({ data: await projects.readSource(input, context), ...identity(input.id) })),
    },
    "source.validate": {
      title: "Validate Kit source changes",
      description: `${changeDescription} Requires Admin. Checks syntax, imports and entrypoints without executing code or persisting changes.`,
      input: SourceChangeInput,
      data: changed,
      openWorld: false,
      run: ({ id, ...input }, context) =>
        result(context, async () => ({ data: await projects.changeSource(id, input, context), ...identity(id) })),
    },
  },
  actions: {
    "app.create": {
      title: "Create Kit app",
      description: "Create a new app with a README page and optional shared RSQL database. Returns ID, revision and database state. Use source.apply next. Never repurpose an unrelated existing app; never auto-launches or shares. If provisioning is pending, reuse the returned app ID and read database.status; do not create another app.",
      input: CreateAppInput,
      data: appLifecycleResult, destructive: false, openWorld: false, idempotency: "required",
      approval: "rememberable",
      review: async (input, context) => {
        const checked = await result(context, async () => { user(context); return { data: input }; });
        if (!checked.ok) return checked;
        return ok({ message: messages.resolve([context.locale]).t.create, approvalScope: "apps:create", details: [{ label: messages.resolve([context.locale]).t.settings, value: JSON.stringify(input) }] });
      },
      run: (input, context) => result(context, async () => {
        const created = await projects.createApp(input, context);
        return { data: created, ...identity(created.id) };
      }),
    },
    "app.update": {
      title: "Update Kit app",
      description: "Change name, description or databaseEnabled for one app as Admin, using exact expectedRevision. Omitted fields and all source files remain unchanged. Disabling the database preserves data; no reset, deletion, sharing or launch. Read returned database state before using it.",
      input: UpdateAppInput,
      data: appLifecycleResult, destructive: false, openWorld: false, idempotency: "required",
      approval: "rememberable",
      review: async ({ id, ...input }, context) => {
        const checked = await result(context, async () => { const app = await projects.get(id, context, "admin"); if (app.revision !== input.expectedRevision) throw new ProjectError(409, "REVISION_CONFLICT"); return { data: app }; });
        if (!checked.ok) return checked;
        return ok({ message: messages.resolve([context.locale]).t.update, details: [{ label: messages.resolve([context.locale]).t.app, value: checked.data.data.name }, { label: messages.resolve([context.locale]).t.settings, value: JSON.stringify(input) }], approvalScope: `app:${id}:settings` });
      },
      run: ({ id, ...input }, context) => result(context, async () => ({ data: { ...await projects.metadata(id, input, context), database: await database.status(id, context) }, ...identity(id) })),
    },
    "database.write": {
      title: "Change Kit database",
      description:
        "Create or change schema (Admin), or insert/update/delete records (Use). Requires an already enabled database. Writes are not automatically replayed after errors.",
      input: DatabaseCall.extend({
        id: AppId,
        request: z.discriminatedUnion("operation", [tablesCreate, tablesUpdate, tablesDelete, rowsInsert, rowsUpdate, rowsDelete]).describe("One structured schema or record mutation; no SQL strings."),
      }),
      data: z.unknown(),
      destructive: true,
      openWorld: false,
      idempotency: "required",
      review: async ({ id, generation, request }: z.infer<typeof DatabaseCall> & { id: string }, context: CapabilityExecutionContext) => {
        const checked = await result(context, async () => {
          await projects.get(id, context, request.operation.startsWith("tables.") ? "admin" : "write");
          const state = await database.status(id, context);
          if (!state.enabled || !state.globallyEnabled || state.generation !== generation) throw new DatabaseError("DB_STALE", 409);
          return { data: state };
        });
        if (!checked.ok) return checked;
        return ok({
          message: context.locale.startsWith("de")
            ? "Diese Datenbankänderung ausführen? Bestätigte Schreibvorgänge werden nicht automatisch wiederholt."
            : "Apply this database change? Confirmed writes are not automatically replayed.",
          details: [
            { label: "App", value: id },
            { label: context.locale.startsWith("de") ? "Aktion" : "Operation", value: request.operation },
            { label: context.locale.startsWith("de") ? "Änderung" : "Change", value: JSON.stringify(request) },
          ],
        });
      },
      run: ({ id, generation, request }, context) =>
        result(context, async () => ({ data: await database.call(id, generation, request, context), ...identity(id) })),
    },
    "source.apply": {
      title: "Save Kit source changes",
      description: `${changeDescription} Requires Admin. Changes source only; never creates, deletes, launches or shares an app.`,
      input: SourceChangeInput,
      data: changed,
      destructive: true,
      openWorld: false,
      idempotency: "required",
      review: async ({ id, ...input }: z.infer<typeof SourceChangeInput>, context: CapabilityExecutionContext) => {
        const checked = await result(context, async () => {
          await projects.changeSource(id, input, context);
          return { data: await projects.manifest(id, context) };
        });
        if (!checked.ok) return checked;
        const t = messages.resolve([context.locale]).t;
        const paths = [
          ...input.upsert.map((f) => `+ ${f.path}`),
          ...input.edits.map((f) => `~ ${f.path}`),
          ...input.delete.map((p) => `− ${p}`),
        ];
        // Keep every affected path while respecting the review's 10,000-character value limit.
        const pathDetails = [];
        for (let offset = 0; offset < paths.length; offset += 32) {
          pathDetails.push({
            label: `${t.files} ${Math.floor(offset / 32) + 1}`,
            value: paths.slice(offset, offset + 32).join("\n"),
            display: "block" as const,
          });
        }
        return ok({
          message: t.apply,
          details: [
            { label: t.app, value: checked.data.data.name },
            { label: t.revision, value: String(input.expectedRevision) },
            ...pathDetails,
          ],
          links: [{ rel: "edit" as const, href: `/app/kit/${id}/edit` }],
        });
      },
      run: ({ id, ...input }, context) =>
        result(context, async () => ({
          data: await projects.changeSource(id, input, context, true),
          summary: messages.resolve([context.locale]).t.saved,
          ...identity(id),
        })),
    },
  },
});
