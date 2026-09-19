import {
  CAPABILITY_MAX_RESULT_BYTES,
  type CapabilityExecutionContext,
  defineCapabilities,
  UniversalSearchDataSchema,
  UniversalSearchInputSchema,
} from "@k2b/cloud/contracts";
import { err, fail, fileIcons, ok } from "@k2b/stdlib";
import { z } from "zod";
import { persistedEntryRefId, resolveEntryRefId } from "./data/references";
import { filesUrl } from "./frontend/urls";
import { ENTRY_TYPE } from "./resource-ref";
import { FilesError, filesService } from "./service";

const EntryReadInputSchema = z
  .object({ id: z.string().min(1).max(512).describe("Entry ID from a filesv2.entry ref or search result.") })
  .strict();
const EntryDataSchema = z.object({
  id: z.string(),
  base: z.object({ id: z.string(), name: z.string(), area: z.enum(["cloud", "freeipa"]) }),
  path: z.string(),
  name: z.string(),
  directory: z.boolean(),
  size: z.number(),
  modified: z.string(),
  href: z.string(),
});
/** Global search fans out over every accessible base; the count of bases is the user's own membership, not user input. */
const SEARCH_BASE_LIMIT = 10;
const userActor = (context: CapabilityExecutionContext) => (context.actor.kind === "user" ? context.actor : null);
const parent = (path: string) => path.split("/").slice(0, -1).join("/");
const entryHref = (baseId: string, path: string, directory: boolean) =>
  directory ? filesUrl(baseId, path) : filesUrl(baseId, parent(path), null, path);

export const filesCapabilities = defineCapabilities({
  protocolVersion: 2,
  types: {
    entry: {
      title: "File or folder",
      description: "One file or folder in an accessible Cloud or FreeIPA storage base.",
      icon: "ti ti-folders",
      reader: "entry.read",
    },
  },
  queries: {
    "entry.read": {
      title: "Read file entry",
      description: "Read the current metadata of one filesv2.entry ref after checking access.",
      input: EntryReadInputSchema,
      data: EntryDataSchema,
      openWorld: false,
      run: async (input, context) => {
        const actor = userActor(context);
        if (!actor) return fail(err.forbidden("File entries are read on behalf of a signed-in user."));
        const ref = await resolveEntryRefId(input.id);
        if (!ref) return fail(err.notFound("File entry"));
        try {
          const result = await filesService.entry(actor, ref);
          return ok({
            data: {
              id: input.id,
              base: { id: result.base.id, name: result.base.name, area: result.base.area },
              ...result.entry,
              href: entryHref(result.base.id, result.entry.path, result.entry.directory),
            },
          });
        } catch (error) {
          if (error instanceof FilesError && error.status === 404) return fail(err.notFound("File entry"));
          if (error instanceof FilesError && error.status === 403) return fail(err.forbidden(error.code));
          throw error;
        }
      },
    },
    "entry.search": {
      title: "Search files",
      description:
        "Find file and folder names in up to 10 accessible storage bases, one bounded source page each. The summary reports omitted bases or further results; browse Files for complete results.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: {
        tags: [{ tag: "file", title: "Files", description: "Search file and folder names.", aliases: ["files", "folder", "folders"] }],
      },
      run: async ({ query, limit }, context) => {
        const actor = userActor(context);
        if (!actor) return fail(err.forbidden("File search runs on behalf of a signed-in user."));
        const q = query.trim();
        const available = (await filesService.bases(actor)).items;
        const readable = available.filter((base) => base.status === "existing");
        const bases = readable.slice(0, SEARCH_BASE_LIMIT);
        // Query failures are failures, never empty search results. Promise.all bounds fan-out to ten.
        const pages = await Promise.all(
          bases.map((base) => (q ? filesService.search(actor, { baseId: base.id, q }) : filesService.list(actor, { baseId: base.id }))),
        );
        const entries = pages.flatMap((page) =>
          (q ? page.items : [...page.items].sort((a, b) => b.modified.localeCompare(a.modified))).map((entry) => ({ page, entry })),
        );
        const data = await Promise.all(
          entries.slice(0, limit).map(async ({ page, entry }) => {
            const id = await persistedEntryRefId(page.base.id, entry.path);
            const folder = parent(entry.path);
            return {
              ref: { type: ENTRY_TYPE, id },
              title: entry.name,
              preview: `${page.base.name}${folder ? ` / ${folder}` : ""}`.slice(0, 2000),
              icon: `ti ${fileIcons.getFileIcon({ name: entry.name, type: entry.directory ? "directory" : "file" })}`,
              priority: entry.directory ? 5 : 6,
              metadata: [{ label: context.locale?.startsWith("de") ? "Ablage" : "Storage", value: page.base.name }],
              links: [
                {
                  rel: "open" as const,
                  href:
                    entryHref(page.base.id, entry.path, entry.directory).length <= 2048
                      ? entryHref(page.base.id, entry.path, entry.directory)
                      : `/app/filesv2/ref/${encodeURIComponent(id)}`,
                },
              ],
            };
          }),
        );
        // Leave room for the result envelope and its explanatory summary. Count UTF-8 and JSON escaping.
        const byteLimit = CAPABILITY_MAX_RESULT_BYTES - 2048;
        let bytes = 2;
        const bounded = [];
        for (const item of data) {
          const itemBytes = new TextEncoder().encode(JSON.stringify(item)).byteLength + 1;
          if (bytes + itemBytes > byteLimit) break;
          bounded.push(item);
          bytes += itemBytes;
        }
        const omittedBases = readable.length - bases.length;
        const unavailableBases = available.filter((base) => base.status !== "existing").length;
        const limited =
          bounded.length < data.length ||
          omittedBases > 0 ||
          unavailableBases > 0 ||
          entries.length > limit ||
          pages.some((page) => page.next);
        const summary = limited
          ? context.locale?.startsWith("de")
            ? `Unvollständige Ergebnisse: ${bases.length} Ablagen geprüft, ${omittedBases} weitere und ${unavailableBases} nicht verfügbare Ablagen. Weitere Treffer können vorhanden sein. In Dateien weitersuchen.`
            : `Partial results: ${bases.length} storage bases searched, ${omittedBases} further and ${unavailableBases} unavailable bases. More entries may exist. Continue searching in Files.`
          : undefined;
        return ok({ data: bounded, ...(summary ? { summary } : {}) });
      },
    },
  },
});
