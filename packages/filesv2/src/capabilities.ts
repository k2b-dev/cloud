import { type CapabilityExecutionContext, defineCapabilities, UniversalSearchDataSchema, UniversalSearchInputSchema } from "@k2b/cloud/contracts";
import { err, fail, fileIcons, ok } from "@k2b/stdlib";
import { z } from "zod";
import { filesUrl } from "./frontend/urls";
import { ENTRY_TYPE, entryRefId, parseEntryRefId } from "./resource-ref";
import { FilesError, filesService } from "./service";

const EntryReadInputSchema = z.object({ id: z.string().min(1).max(512).describe("Entry ID from a filesv2.entry ref or search result.") }).strict();
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
const entryHref = (baseId: string, path: string, directory: boolean) => (directory ? filesUrl(baseId, path) : filesUrl(baseId, parent(path), null, path));

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
        const ref = parseEntryRefId(input.id);
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
      description: "Find files and folders by name across every storage base the user can read.",
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
        if (!q) return ok({ data: [] });
        const bases = (await filesService.bases(actor)).items.filter((base) => base.status === "existing").slice(0, SEARCH_BASE_LIMIT);
        const pages = await Promise.all(
          bases.map((base) => filesService.search(actor, { baseId: base.id, q }).catch(() => ({ base, items: [] }))),
        );
        const data = pages
          .flatMap((page) =>
            page.items.map((entry) => {
              const id = entryRefId(page.base.id, entry.path);
              if (!id) return null;
              const folder = parent(entry.path);
              return {
                ref: { type: ENTRY_TYPE, id },
                title: entry.name,
                preview: `${page.base.name}${folder ? ` / ${folder}` : ""}`,
                icon: `ti ${fileIcons.getFileIcon({ name: entry.name, type: entry.directory ? "directory" : "file" })}`,
                priority: entry.directory ? 5 : 6,
                metadata: [{ label: "Storage", value: page.base.name }],
                links: [{ rel: "open" as const, href: entryHref(page.base.id, entry.path, entry.directory) }],
              };
            }),
          )
          .filter((item) => item !== null)
          .slice(0, limit);
        return ok({ data });
      },
    },
  },
});
