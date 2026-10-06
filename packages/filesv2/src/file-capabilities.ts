import { createHash } from "node:crypto";
import {
  type CapabilityActionDefinition,
  type CapabilityExecutionContext,
  type CapabilityResult,
  type CapabilityStream,
  FILE_PROVIDER_NAME_CONFLICT,
  type FileProviderEntry,
  FileProviderListDataSchema,
  FileProviderListInputSchema,
  FileProviderSaveInputSchema,
} from "@k2b/cloud/contracts";
import { FilegateError } from "@k2b/filegate";
import { err, fail, fileIcons, isServiceError, ok } from "@k2b/stdlib";
import { z } from "zod";
import { filegateErrorCode } from "./api/filegate-error";
import { BrowseQuerySchema, CONTENT_STREAM_LIMIT, type FileEntry } from "./contracts";
import { entryRef } from "./data/references";
import { markdownRevision } from "./document-assets";
import { baseLabel } from "./frontend/base-label";
import { browserMessages } from "./frontend/browser-messages";
import { filesUrl } from "./frontend/urls";
import { FilesError, filesService } from "./service";

// Match the existing code-run file budget and stay within Cloud HTTP body budgets.
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
    if (e instanceof FilegateError) {
      const code = filegateErrorCode(e);
      const status = code === "forbidden" ? 403 : code === "not_found" ? 404 : code === "unavailable" ? 503 : 409;
      throw { code, message: code, status };
    }
    throw e;
  }
}
/** Files reports a taken name as these 409 codes; provider.save answers all of them with the contract's one code. */
const NAME_TAKEN = new Set(["path_conflict", "not_file", "write_conflict"]);
async function saveDomain<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await domain(run);
  } catch (e) {
    if (isServiceError(e) && e.status === 409 && NAME_TAKEN.has(e.code))
      throw { code: FILE_PROVIDER_NAME_CONFLICT, message: "A file or folder with this name already exists", status: 409 };
    throw e;
  }
}
type ListedEntry = z.infer<typeof Entry> & { resourceId?: string };
const item = async (baseId: string, { resourceId, ...entry }: ListedEntry) => ({
  ...entry,
  revision: markdownRevision(entry),
  ref: { type: "filesv2.entry" as const, id: await entryRef(baseId, { path: entry.path, resourceId }) },
});
/** Capability links hold at most 2,048 characters; a deep path opens through the entry's deep link instead. */
const openLink = (href: string, id: string) => [
  { rel: "open" as const, href: href.length <= 2048 ? href : `/app/filesv2/ref/${encodeURIComponent(id)}` },
];
const result = async (baseId: string, entry: ListedEntry): Promise<CapabilityResult<z.infer<typeof Result>>> => {
  const listed = await item(baseId, entry);
  return {
    data: { baseId, entry: listed },
    links: openLink(filesUrl(baseId, entry.directory ? entry.path : entry.path.split("/").slice(0, -1).join("/")), listed.ref.id),
  };
};
/** Bun's media type table, by extension only; Files never sniffs content. */
const mediaTypeOf = (name: string) => Bun.file(name).type;

const providerEntry = async (baseId: string, entry: FileEntry): Promise<FileProviderEntry> => {
  const facts = {
    id: await entryRef(baseId, entry),
    name: entry.name,
    updatedAt: entry.modified,
    icon: `ti ${fileIcons.getFileIcon({ name: entry.name, type: entry.directory ? "directory" : "file" })}`,
  };
  return entry.directory ? { kind: "folder", ...facts } : { kind: "file", ...facts, size: entry.size, mediaType: mediaTypeOf(entry.name) };
};

/** The provider root: the caller's usable storage bases as folders, under the names Files shows. Never writable. */
const providerRoot = async (c: CapabilityExecutionContext, input: z.output<typeof FileProviderListInputSchema>) => {
  const offset = input.cursor === undefined ? 0 : /^\d{1,6}$/.test(input.cursor) ? Number(input.cursor) : -1;
  if (offset < 0) throw new FilesError("cursor_invalid", 409);
  const locale = c.locale ?? "en";
  const messages = browserMessages.resolve([locale]).t;
  const q = input.query?.trim().toLocaleLowerCase();
  const available = await filesService.bases(readActor(c));
  // An outage must not look like lost storage: fail the whole root, even beside usable bases, so consumers offer a retry.
  if (available.issues.some((issue) => issue.code === "unavailable") || available.items.some((base) => base.reason === "unavailable"))
    throw new FilesError("unavailable", 503);
  const bases = available.items
    .filter((base) => base.status === "existing")
    .map((base) => ({ base, name: baseLabel(base, messages, locale) }))
    .filter(({ name }) => !q || name.toLocaleLowerCase().includes(q))
    .sort((a, b) => (a.base.kind === b.base.kind ? a.name.localeCompare(b.name, locale) : a.base.kind === "users" ? -1 : 1));
  const page = bases.slice(offset, offset + input.limit);
  return {
    writable: false,
    items: await Promise.all(
      page.map(async ({ base, name }) => ({
        kind: "folder" as const,
        id: await entryRef(base.id, { path: "" }),
        name,
        icon: base.kind === "users" ? "ti ti-home" : "ti ti-users",
      })),
    ),
    next: offset + page.length < bases.length ? String(offset + page.length) : null,
  };
};

const SavedFile = z
  .object({
    file: z
      .object({ id: z.string().min(1).max(512), name: z.string().min(1).max(255), size: z.number().int().min(0) })
      .strict()
      .optional(),
  })
  .strict();
const savedFile = async (baseId: string, entry: FileEntry): Promise<CapabilityResult<z.infer<typeof SavedFile>>> => {
  const id = await entryRef(baseId, entry);
  return {
    data: { file: { id, name: entry.name, size: entry.size } },
    links: openLink(filesUrl(baseId, entry.path.split("/").slice(0, -1).join("/")), id),
  };
};

const uploadRef = z.object({ baseId: Base, id: z.uuid() }).strict();
const joinName = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
/** The write stream of an upload session; `receipt` shapes the completed result and `errors` the failures of its Action. */
const uploadStream = <T>(receipt: (baseId: string, entry: FileEntry) => Promise<CapabilityResult<T>>, errors = domain) => ({
  direction: "write" as const,
  maxBytes: CONTENT_STREAM_LIMIT,
  write: async (s: CapabilityStream, body: ReadableStream<Uint8Array>, c: CapabilityExecutionContext) =>
    errors(async () => {
      const ref = uploadRef.parse(JSON.parse(s.id));
      const saved = await filesService.capabilityUpload(readActor(c), ref, body, c.signal);
      return receipt(ref.baseId, saved.entry);
    }),
  status: async (s: CapabilityStream, c: CapabilityExecutionContext) =>
    errors(async () => {
      const ref = uploadRef.parse(JSON.parse(s.id));
      const status = await filesService.capabilityUploadStatus(readActor(c), ref);
      return status.state === "completed" ? { state: "completed" as const, result: await receipt(ref.baseId, status.entry) } : status;
    }),
  abort: async (s: CapabilityStream, c: CapabilityExecutionContext) =>
    domain(() => filesService.abortUpload(readActor(c), uploadRef.parse(JSON.parse(s.id)))),
});
const sourceRef = z.object({ id: z.string().max(512), revision: z.string().max(512) }).strict();
const uuidKey = (key: string) => {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const Upload = Location.extend({
  path: Path.min(1),
  size: z.number().int().min(0).max(CONTENT_STREAM_LIMIT).describe("Exact byte count of the new content."),
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
      maxBytes: CONTENT_STREAM_LIMIT,
      read: async (s: CapabilityStream, c: CapabilityExecutionContext) =>
        domain(async () => {
          const source = sourceRef.parse(JSON.parse(s.id));
          return filesService.capabilityDownload(readActor(c), source, c.signal);
        }),
    },
    run: async (input: { id: string }, c: CapabilityExecutionContext) =>
      domain(async () => {
        const file = await filesService.entryById(readActor(c), input.id);
        if (file.entry.directory) return fail(err.badInput("Choose a file, not a folder"));
        if (file.entry.size > CONTENT_STREAM_LIMIT) return fail(err.badInput("File exceeds the 50 MiB stream budget"));
        return ok({
          ...(await result(file.base.id, file.entry)),
          stream: {
            id: JSON.stringify({ id: input.id, revision: markdownRevision(file.entry) }),
            direction: "read" as const,
            name: file.entry.name,
            mediaType: mediaTypeOf(file.entry.name),
            size: file.entry.size,
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          },
        });
      }),
  },
  "content.download": {
    title: "Get file download link",
    description:
      "Request a direct single-file download lease only when the user downloads a filesv2.entry from listing or search. Rechecks current access. Returns a bearer URL valid for 60 seconds; never store it in a list or shared data. Use content.read for processing bytes in code.",
    input: z
      .object({ id: z.string().min(1).max(512).describe("Exact ID from a filesv2.entry ref returned by listing or search.") })
      .strict(),
    data: z.object({
      url: z.string().describe("Private bearer URL from the download service. Use unchanged without Cloud credentials."),
      method: z.literal("GET"),
      expires: z.string().describe("Lease expiry timestamp returned by storage. Request a fresh lease after expiry."),
    }),
    openWorld: false,
    run: async (input: { id: string }, c: CapabilityExecutionContext) =>
      domain(async () => {
        return ok({ data: await filesService.downloadById(readActor(c), input.id) });
      }),
  },
  "provider.list": {
    title: "Browse files for a file chooser",
    description:
      "Read one page of a folder for choosing or saving files: without parent, the accessible storage bases; inside, readable folders first, then files. Continue with next until null, including empty filtered pages. Open files with content.read.",
    input: FileProviderListInputSchema,
    data: FileProviderListDataSchema,
    openWorld: false,
    run: async (input: z.output<typeof FileProviderListInputSchema>, c: CapabilityExecutionContext) =>
      domain(async () => {
        if (input.parent === undefined) return ok({ data: await providerRoot(c, input) });
        // A Filegate read may join folders and files on one page; half the limit keeps that page within it.
        const page = await filesService.folder(readActor(c), {
          id: input.parent,
          q: input.query,
          after: input.cursor,
          pageSize: Math.ceil(input.limit / 2),
        });
        return ok({
          data: {
            writable: page.writable,
            items: await Promise.all(page.items.map((entry) => providerEntry(page.base.id, entry))),
            next: page.next,
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
        const session = await filesService.upload(readActor(c), {
          ...input,
          idempotencyKey: uuidKey(JSON.stringify(["filesv2.content.create", readActor(c).user.id, c.idempotencyKey!])),
        });
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
    stream: uploadStream(result),
  },
  "provider.save": {
    title: "Save a new file",
    description:
      "Create one new file in a writable folder from provider.list, then send its bytes through the write stream. Never replaces: an existing name fails with code FILE_NAME_CONFLICT; choose another name.",
    input: FileProviderSaveInputSchema,
    data: SavedFile,
    openWorld: false,
    destructive: false,
    idempotency: "required" as const,
    review: async (input: z.output<typeof FileProviderSaveInputSchema>, c: CapabilityExecutionContext) =>
      domain(async () => {
        const folder = await filesService.folderLocation(readActor(c), input.parent);
        return ok({ message: `Create ${joinName(folder.path, input.name)} (${input.size} bytes) in ${folder.baseId}.` });
      }),
    run: async (input: z.output<typeof FileProviderSaveInputSchema>, c: CapabilityExecutionContext) =>
      saveDomain(async () => {
        if (input.size > CONTENT_STREAM_LIMIT) return fail(err.badInput("File exceeds the 50 MiB stream budget"));
        const actor = readActor(c);
        const folder = await filesService.folderLocation(actor, input.parent);
        const session = await filesService.upload(actor, {
          baseId: folder.baseId,
          path: joinName(folder.path, input.name),
          size: input.size,
          onConflict: "error",
          idempotencyKey: uuidKey(JSON.stringify(["filesv2.provider.save", actor.user.id, c.idempotencyKey!])),
        });
        return ok({
          data: {},
          stream: {
            id: JSON.stringify({ baseId: folder.baseId, id: session.id }),
            direction: "write" as const,
            name: input.name,
            mediaType: input.mediaType,
            size: input.size,
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          },
        });
      }),
    stream: uploadStream(savedFile, saveDomain),
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
