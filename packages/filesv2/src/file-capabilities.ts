import { createHash } from "node:crypto";
import type { CapabilityActionDefinition, CapabilityExecutionContext, CapabilityResult, CapabilityStream } from "@k2b/cloud/contracts";
import { err, fail, ok } from "@k2b/stdlib";
import { z } from "zod";
import { BrowseQuerySchema } from "./contracts";
import { persistedEntryRefId, resolveEntryRefId } from "./data/references";
import { markdownRevision } from "./document-assets";
import { filesUrl } from "./frontend/urls";
import { FilesError, filesService } from "./service";

// Match the existing code-run file budget and stay within Cloud HTTP body budgets.
const MAX_BYTES = 50 * 1024 * 1024;
const Base = z.string().min(1).max(512).describe("Exact base ID returned by bases.list.");
const Path = z.string().max(4096).describe("Path relative to this storage base; empty means its root.");
const Location = z.object({ baseId: Base, path: Path }).strict();
const Browse = BrowseQuerySchema.extend({
  baseId: Base,
  path: BrowseQuerySchema.shape.path.describe("Folder path relative to the storage base."),
  after: BrowseQuerySchema.shape.after.describe("Cursor from the previous page; omit for the first page."),
  sort: BrowseQuerySchema.shape.sort.describe("Sort entries by this field."),
  order: BrowseQuerySchema.shape.order.describe("Ascending or descending order."),
  type: BrowseQuerySchema.shape.type.describe("Include all entries, files or directories."),
  groupFolders: BrowseQuerySchema.shape.groupFolders.describe("Group directories before files."),
}).strict();
const Target = Location.extend({ path: Path.min(1) }).strict();
const Entry = z.object({
  name: z.string(),
  path: z.string(),
  directory: z.boolean(),
  size: z.number(),
  modified: z.string(),
  revision: z.string().optional(),
});
const Ref = z.object({ type: z.literal("filesv2.entry"), id: z.string() });
const Item = Entry.extend({ ref: Ref });
const Result = z.object({ baseId: Base, entry: Item.optional(), uploadId: z.string().optional() });
const readActor = (c: CapabilityExecutionContext) => {
  if (c.actor.kind !== "user") throw err.forbidden("Files require a signed-in user.");
  return c.actor;
};
async function domain<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof FilesError) throw { code: e.code, message: e.code, status: e.status };
    throw e;
  }
}
const item = async (baseId: string, entry: z.infer<typeof Entry>) => ({
  ...entry,
  revision: markdownRevision(entry),
  ref: { type: "filesv2.entry" as const, id: await persistedEntryRefId(baseId, entry.path) },
});
const result = async (baseId: string, entry: z.infer<typeof Entry>): Promise<CapabilityResult<z.infer<typeof Result>>> => ({
  data: { baseId, entry: await item(baseId, entry) },
  links: [{ rel: "open", href: filesUrl(baseId, entry.directory ? entry.path : entry.path.split("/").slice(0, -1).join("/")) }],
});
const uploadRef = z.object({ baseId: Base, id: z.uuid() }).strict();
const sourceRef = z.object({ id: z.string().max(512), revision: z.string().max(512) }).strict();
const uuidKey = (key: string) => {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const Upload = Location.extend({
  path: Path.min(1),
  size: z.number().int().min(0).max(MAX_BYTES).describe("Exact byte count of the new content."),
  mediaType: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[\x20-\x7e]+$/)
    .default("application/octet-stream")
    .describe("Media type of the binary payload."),
  onConflict: z.enum(["error", "overwrite"]).default("error").describe("Create only, or explicitly replace an existing file."),
  expectedRevision: z.string().max(512).optional().describe("Current revision from entry metadata; required when replacing."),
})
  .strict()
  .refine((value) => value.onConflict !== "overwrite" || Boolean(value.expectedRevision), "Replacing requires expectedRevision");

export const fileQueries = {
  "bases.list": {
    title: "List storage bases",
    description: "List accessible homes and group storage. Use the returned base IDs for browsing; unavailable bases include their state.",
    input: z.object({ after: Base.optional() }).strict(),
    data: z.object({
      items: z.array(
        z.object({ id: Base, name: z.string(), area: z.enum(["cloud", "freeipa"]), kind: z.enum(["users", "groups"]), status: z.string() }),
      ),
      next: z.string().nullable(),
    }),
    openWorld: false,
    run: async (input: { after?: string }, c: CapabilityExecutionContext) =>
      domain(async () => {
        const available = (await filesService.bases(readActor(c))).items
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .filter((i) => !input.after || i.id > input.after);
        const items = available.slice(0, 100);
        return ok({ data: { items, next: available.length > items.length ? items.at(-1)!.id : null } });
      }),
  },
  "entry.list": {
    title: "List folder entries",
    description: "Read one page of immediate children of a known folder. Continue with next until null, including empty filtered pages.",
    input: Browse,
    data: z.object({ baseId: Base, path: Path, items: z.array(Item), next: z.string().nullable() }),
    openWorld: false,
    run: async (input: z.infer<typeof BrowseQuerySchema> & { baseId: string }, c: CapabilityExecutionContext) =>
      domain(async () => {
        const page = await filesService.list(readActor(c), input);
        return ok({
          data: {
            baseId: input.baseId,
            path: page.path,
            items: await Promise.all(page.items.map((e) => item(input.baseId, e))),
            next: page.next,
          },
        });
      }),
  },
  "entry.search-in-base": {
    title: "Search within storage",
    description: "Find names in one known storage base or folder, with complete cursor traversal. Does not search file contents.",
    input: Browse.extend({ q: z.string().min(1).max(500).describe("File or folder name to find.") }).strict(),
    data: z.object({ baseId: Base, path: Path, items: z.array(Item), next: z.string().nullable() }),
    openWorld: false,
    run: async (input: z.infer<typeof BrowseQuerySchema> & { baseId: string; q: string }, c: CapabilityExecutionContext) =>
      domain(async () => {
        const page = await filesService.search(readActor(c), { ...input, scope: "tree" });
        return ok({
          data: {
            baseId: input.baseId,
            path: page.path,
            items: await Promise.all(page.items.map((e) => item(input.baseId, e))),
            next: page.next,
          },
        });
      }),
  },
  "trash.list": {
    title: "List trash",
    description: "List one page of recoverable entries; next is the cursor for the following page.",
    input: z.object({ baseId: Base, after: z.string().max(16384).optional().describe("Cursor returned by the previous page.") }).strict(),
    data: z.object({
      base: z.object({ id: Base, name: z.string() }),
      entries: z.array(
        z.object({
          id: z.string(),
          original: z.string().nullable(),
          name: z.string(),
          directory: z.boolean(),
          deletedAt: z.string().nullable(),
          state: z.string().optional(),
          error: z.string().optional(),
        }),
      ),
      next: z.string().nullable(),
    }),
    openWorld: false,
    run: async (input: { baseId: string; after?: string }, c: CapabilityExecutionContext) =>
      domain(async () => ok({ data: await filesService.trash(readActor(c), input) })),
  },
  "content.read": {
    title: "Read file content",
    description: "Open one file as an authenticated binary stream. Use its filesv2.entry ID from search or listing. No text truncation.",
    input: z.object({ id: z.string().min(1).max(512).describe("Entry ID from listing or search.") }).strict(),
    data: Result,
    openWorld: false,
    stream: {
      direction: "read" as const,
      maxBytes: MAX_BYTES,
      read: async (s: CapabilityStream, c: CapabilityExecutionContext) =>
        domain(async () => {
          const source = sourceRef.parse(JSON.parse(s.id));
          const ref = await resolveEntryRefId(source.id);
          if (!ref) throw err.notFound("File");
          return filesService.capabilityDownload(readActor(c), { ...ref, revision: source.revision }, c.signal);
        }),
    },
    run: async (input: { id: string }, c: CapabilityExecutionContext) =>
      domain(async () => {
        const ref = await resolveEntryRefId(input.id);
        if (!ref) return fail(err.notFound("File"));
        const file = await filesService.entry(readActor(c), ref);
        if (file.entry.directory) return fail(err.badInput("Choose a file, not a folder"));
        if (file.entry.size > MAX_BYTES) return fail(err.badInput("File exceeds the 50 MiB stream budget"));
        return ok({
          ...(await result(ref.baseId, file.entry)),
          stream: {
            id: JSON.stringify({ id: input.id, revision: markdownRevision(file.entry) }),
            direction: "read" as const,
            name: file.entry.name,
            mediaType: "application/octet-stream",
            size: file.entry.size,
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          },
        });
      }),
  },
};

const successfulEntry = <T>(value: { results: ({ ok: true; entry: T } | { ok: false; error: string })[] }) => {
  const first = value.results[0];
  if (!first?.ok) throw err.conflict(first?.error ?? "File operation failed");
  return first.entry;
};
function action<S extends z.ZodType>(
  title: string,
  input: S,
  run: (input: z.output<S>, c: CapabilityExecutionContext) => Promise<CapabilityResult<z.infer<typeof Result>>>,
): CapabilityActionDefinition<S, typeof Result> {
  return {
    title,
    description: title + " using current storage permissions. Existing targets are not overwritten.",
    input,
    data: Result,
    openWorld: false,
    destructive: false,
    idempotency: "required",
    review: async (value, c) =>
      domain(async () => {
        readActor(c);
        return ok({ message: `${title}: ${JSON.stringify(value)}`.slice(0, 1000) });
      }),
    run: async (value, c) => domain(async () => ok(await run(value, c))),
  };
}
export const fileActions = {
  "content.create": {
    title: "Write file content",
    description:
      "Prepare one binary upload at an exact base-relative path. Default: create only. Replacing requires an expectedRevision obtained from current metadata.",
    input: Upload,
    data: Result,
    openWorld: false,
    destructive: false,
    idempotency: "required" as const,
    review: async (input: z.infer<typeof Upload>, c: CapabilityExecutionContext) =>
      domain(async () => {
        await filesService.list(readActor(c), { baseId: input.baseId, path: input.path.split("/").slice(0, -1).join("/") });
        return ok({
          message: `${input.onConflict === "overwrite" ? "Replace" : "Create"} ${input.path} (${input.size} bytes) in ${input.baseId}.`,
        });
      }),
    run: async (input: z.infer<typeof Upload>, c: CapabilityExecutionContext) =>
      domain(async () => {
        if (input.onConflict === "overwrite" && !input.expectedRevision) return fail(err.badInput("Replacing requires expectedRevision"));
        const session = await filesService.upload(readActor(c), { ...input, idempotencyKey: uuidKey(c.idempotencyKey!) });
        return ok({
          data: { baseId: input.baseId, uploadId: session.id },
          stream: {
            id: JSON.stringify({ baseId: input.baseId, id: session.id }),
            direction: "write" as const,
            name: input.path.split("/").at(-1)!,
            mediaType: input.mediaType,
            size: input.size,
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          },
        });
      }),
    stream: {
      direction: "write" as const,
      maxBytes: MAX_BYTES,
      write: async (s: CapabilityStream, body: ReadableStream<Uint8Array>, c: CapabilityExecutionContext) =>
        domain(async () => {
          const ref = uploadRef.parse(JSON.parse(s.id));
          const saved = await filesService.capabilityUpload(readActor(c), ref, body, c.signal);
          return result(ref.baseId, saved.entry);
        }),
      status: async (s: CapabilityStream, c: CapabilityExecutionContext) =>
        domain(async () => {
          const ref = uploadRef.parse(JSON.parse(s.id));
          const status = await filesService.capabilityUploadStatus(readActor(c), ref);
          return status.state === "completed" ? { state: "completed" as const, result: await result(ref.baseId, status.entry) } : status;
        }),
      abort: async (s: CapabilityStream, c: CapabilityExecutionContext) =>
        domain(() => filesService.abortUpload(readActor(c), uploadRef.parse(JSON.parse(s.id)))),
    },
  },
  "entry.trash": action("Move entry to trash", Target, async (input, c) => {
    successfulEntry(await filesService.remove(readActor(c), { baseId: input.baseId, paths: [input.path] }));
    return { data: { baseId: input.baseId }, summary: "Moved to trash" };
  }),
  "trash.restore": action(
    "Restore entry from trash",
    z.object({ baseId: Base, id: z.string().max(5500).describe("ID returned by trash.list."), path: Path.optional() }).strict(),
    async (input, c) => {
      const saved = await filesService.restoreTrash(readActor(c), input);
      return result(input.baseId, saved.entry);
    },
  ),
  "folder.create": action("Create folder", Target, async (input, c) => {
    const saved = await filesService.mkdir(readActor(c), input);
    return result(input.baseId, saved.entry);
  }),
  "entry.rename": action(
    "Rename entry",
    Target.extend({ name: z.string().min(1).max(255).describe("New name without directory separators.") }).strict(),
    async (input, c) => {
      const saved = await filesService.rename(readActor(c), input);
      return result(input.baseId, saved.entry);
    },
  ),
  "entry.move": action("Move entry", Target.extend({ folder: Path }).strict(), async (input, c) =>
    result(
      input.baseId,
      successfulEntry(await filesService.move(readActor(c), { baseId: input.baseId, paths: [input.path], folder: input.folder })),
    ),
  ),
  "entry.copy": action("Copy entry", Target.extend({ targetBaseId: Base, folder: Path }).strict(), async (input, c) =>
    result(
      input.targetBaseId,
      successfulEntry(
        await filesService.copy(readActor(c), {
          baseId: input.baseId,
          paths: [input.path],
          targetBaseId: input.targetBaseId,
          folder: input.folder,
        }),
      ),
    ),
  ),
};
