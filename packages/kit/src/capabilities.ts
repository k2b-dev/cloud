import { z } from "zod";
import { ok, fail, i18n } from "@k2b/stdlib";
import {
  defineCapabilities,
  UniversalSearchInputSchema,
  UniversalSearchDataSchema,
  type CapabilityExecutionContext,
  type CapabilityResult,
  type CloudResourceView,
} from "@valentinkolb/cloud/contracts";
import { projects, ProjectError } from "./service";
import { AppId, SourceChangeInput, SourceReadInput, SOURCE_WINDOW } from "./source";
import { apiErrorMessage, ProjectValidationError } from "./errors";
import { LIMITS, PublicId } from "./contracts";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      apply: "Save these source changes. The app will run only when you start it.",
      app: "App",
      revision: "Revision",
      files: "Changed files",
      saved: "Saved source changes",
      invalid: "Check the source changes and file paths.",
    },
    de: {
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
const identity = (id: string) => ({ refs: [{ type: "kit.app", id }], links: [{ rel: "open" as const, href: `/app/kit/${id}` }] });
async function result<T>(context: CapabilityExecutionContext, operation: () => Promise<CapabilityResult<T>>) {
  try {
    return ok(await operation());
  } catch (e) {
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
  "upsert[].path": "Relativer .js-Dateipfad zum Anlegen oder vollständigen Ersetzen.",
  "upsert[].content": "Vollständiger Quelltext. Vor dem Ersetzen die ganze bisherige Datei lesen.",
  delete: "Exakte zu löschende Pfade; Imports im selben Änderungssatz anpassen.",
  edits: "Ein Bereich pro bestehender Datei; jeder Pfad darf nur einmal vorkommen.",
  "edits[].path": "Bestehende Datei für eine gezielte Änderung.",
  "edits[].offset": "UTF-16-Startposition in der angegebenen Revision.",
  "edits[].deleteCount": "Anzahl zu ersetzender UTF-16-Einheiten; null Einheiten fügt ein.",
  "edits[].content": "Einzufügender JavaScript-Text; große Dateien gezielt ändern.",
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
      data: z
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
        .strict(),
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
    "source.apply": {
      title: "Save Kit source changes",
      description: `${changeDescription} Requires Admin. Changes source only; never creates, deletes, launches or shares an app.`,
      input: SourceChangeInput,
      data: changed,
      destructive: true,
      openWorld: false,
      idempotency: "none",
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
