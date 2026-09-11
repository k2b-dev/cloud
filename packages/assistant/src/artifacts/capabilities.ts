import { defineCapabilities, type CapabilityExecutionContext, type CapabilityResult } from "@k2b/cloud/contracts";
import { fail, ok } from "@k2b/stdlib";
import { z } from "zod";
import { ArtifactCreate, ArtifactFile, ArtifactPath, LIMITS } from "./contracts";
import { artifacts, ArtifactError } from "./service";
import { artifactMessages } from "./messages";
import { sourceDiagnostics, sourceManifest } from "./source";

const Id = z.object({ id: z.uuid().describe("App ID returned by code_create or code_list.") }).strict();
const Page = z.number().int().min(1).max(100000).default(1).describe("Page number; follow hasNext to read more.");
const links = (id: string) => ({ refs: [{ type: "assistant.artifact", id }], links: [{ rel: "open" as const,
  href: `/app/assistant?workspace=${encodeURIComponent(JSON.stringify(["app", id]))}`,
}] });
async function result<T>(context: CapabilityExecutionContext, operation: () => Promise<CapabilityResult<T>>) {
  try { return ok(await operation()); }
  catch (error) {
    if (error instanceof ArtifactError) return fail({ code: error.code,
      status: error.code === "ACCESS_DENIED" ? 403 as const : error.code === "NOT_FOUND" ? 404 as const : error.code === "CONFLICT" ? 409 as const : 400 as const,
      message: artifactMessages.resolve([context.locale]).t[error.code],
    });
    if (error instanceof z.ZodError) return fail({ code: "INVALID_INPUT", status: 400 as const, message: artifactMessages.resolve([context.locale]).t.INVALID_INPUT });
    throw error;
  }
}
export const artifactCapabilities = defineCapabilities({
  protocolVersion: 1,
  presentation: { baseLocale: "en", translations: { de: {
    types: { artifact: { title: "Assistant-App", description: "Code und Dateien für Berechnungen oder interaktive Apps." } },
    queries: {
      code_list: { title: "Apps auflisten", description: "Zugängliche Code-Artefakte auflisten." },
      code_read: { title: "Code lesen", description: "Dateiverzeichnis oder den Inhalt einer Datei lesen." },
      code_history: { title: "Verlauf lesen", description: "Frühere Speicherstände auflisten." },
    },
    actions: {
      code_create: { title: "Code-Artefakt erstellen", description: "Ein privates Artefakt erstellen. Startet keinen Code." },
      code_write: { title: "Datei schreiben", description: "Eine Datei erstellen oder überschreiben und sofort speichern." },
      code_remove: { title: "Datei entfernen", description: "Eine Quelldatei entfernen. Die App bleibt erhalten." },
    },
  } } },
  types: { artifact: { title: "Assistant app", description: "Code and files for calculations or interactive apps.", icon: "ti ti-app-window", reader: "code_read" } },
  queries: {
    code_list: {
      title: "List code apps", description: "Find accessible code apps. Reuse the intended app instead of creating duplicates.",
      input: z.object({ page: Page }).strict(), data: z.unknown(), openWorld: false,
      run: ({ page }, context) => result(context, async () => {
        const result = await artifacts.list(context, page);
        return { data: { ...result, items: result.items.map(({ id, title, description, permission }) => ({ id, title, description, permission })) } };
      }),
    },
    code_read: {
      title: "Read code", description: "Read the current file, or omit path for the directory. Follow nextOffset for long files. revision is optional and only needed to inspect history.",
      input: Id.extend({ path: ArtifactPath.optional().describe("Exact relative file path. Omit to list files."), offset: z.number().int().min(0).default(0).describe("UTF-16 offset; follow nextOffset for the remaining content."), revision: z.number().int().positive().optional().describe("Historical revision from code_history. Omit for current files.") }),
      data: z.unknown(), openWorld: false,
      run: ({ id, path, offset, revision }, context) => result<unknown>(context, async () => {
        const bundle = await artifacts.get(id, context, revision);
        if (!path) return { data: sourceManifest(bundle), ...links(id) };
        const file = bundle.source.files.find((file) => file.path === path);
        if (!file) throw new ArtifactError("NOT_FOUND");
        if (offset > file.content.length) throw new ArtifactError("INVALID_INPUT");
        const end = Math.min(file.content.length, offset + LIMITS.text);
        return { data: { id, path, content: file.content.slice(offset, end), nextOffset: end < file.content.length ? end : null, complete: end === file.content.length } };
      }),
    },
    code_history: {
      title: "Read code history", description: "List previous saved versions. Use code_read with a returned revision only when historical source is needed.",
      input: Id.extend({ page: Page }), data: z.unknown(), openWorld: false,
      run: ({ id, page }, context) => result(context, async () => ({ data: await artifacts.history(id, context, page) })),
    },
  },
  actions: {
    code_create: {
      title: "Create code app", description: "Create a private code app for an analysis or interactive tool. Returns id and entry path. Then code_write your source. Does not run or share anything.",
      input: ArtifactCreate.pick({ title: true, description: true }), data: z.unknown(), destructive: false, openWorld: false, idempotency: "required", approval: "none",
      run: ({ title, description }, context) => result(context, async () => {
        const created = await artifacts.create({ title, description, source: { entry: "main.ts", files: [{ path: "main.ts", content: "export default () => {};\n" }] } }, context);
        return { data: sourceManifest(created), ...links(created.id) };
      }),
    },
    code_write: {
      title: "Write code file", description: "Create or overwrite one complete file and save immediately. Other files stay unchanged. Saves incomplete code too and returns compiler diagnostics. No revision or separate save call needed; never auto-runs.",
      input: Id.extend(ArtifactFile.shape), data: z.unknown(), destructive: false, openWorld: false, idempotency: "required", approval: "none",
      run: ({ id, path, content }, context) => result(context, async () => {
        const saved = await artifacts.writeFile(id, path, content, context);
        return { data: { id, path, saved: true, diagnostics: await sourceDiagnostics(saved.source) } };
      }),
    },
    code_remove: {
      title: "Remove code file", description: "Remove one source file, saving immediately. Source history is retained for recovery; does not delete the app. Removing an absent file is harmless. Returns diagnostics for any broken imports.",
      input: Id.extend({ path: ArtifactPath.describe("Exact relative path of the file to remove.") }), data: z.unknown(), destructive: false, openWorld: false, idempotency: "required", approval: "none",
      run: ({ id, path }, context) => result(context, async () => {
        const saved = await artifacts.writeFile(id, path, null, context);
        return { data: { id, path, removed: true, diagnostics: await sourceDiagnostics(saved.source) } };
      }),
    },
  },
});
