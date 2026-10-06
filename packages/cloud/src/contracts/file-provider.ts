import { z } from "zod";
import type { CapabilityManifest } from "./capabilities";
import { type CapabilityContract, type CapabilityContractIssue, capabilityContractIssues } from "./capability-compatibility";

/**
 * Provider-neutral file-provider contract.
 *
 * An application offers files to other applications by declaring
 * `fileProvider: { list, read, save? }` in `defineCapabilities`. Each entry
 * names one of its own Queries or Actions; the schemas below are the minimum
 * both sides share. Identifiers and cursors are opaque provider strings, and
 * the provider authorizes every call with the caller's own access.
 */

// Bounds follow the shared provider page: 100 entries, 3 tags of 40 characters.
const ProviderIdSchema = z.string().min(1).max(2048);
const CursorSchema = z.string().min(1).max(16384);
const TimestampSchema = z.string().datetime({ offset: true });

/** One display chip. Tags describe an entry; they are not a filter or a permission. */
export const FileProviderTagSchema = z
  .object({
    label: z.string().min(1).max(40),
    tone: z.enum(["neutral", "info", "success", "warning", "danger"]).optional(),
  })
  .strict();

export const FileProviderListInputSchema = z
  .object({
    parent: ProviderIdSchema.optional().describe("Folder ID returned by this provider; omit for the provider root."),
    query: z.string().max(200).optional().describe("Optional name filter inside the folder."),
    cursor: CursorSchema.optional().describe("Opaque cursor returned by the previous page; keep parent, query, and limit unchanged."),
    limit: z.number().int().min(1).max(100).default(50).describe("Maximum number of entries to return."),
  })
  .strict();

const entryFacts = {
  id: ProviderIdSchema,
  name: z.string().min(1).max(255),
  updatedAt: TimestampSchema.optional(),
  icon: z.string().min(1).max(120).optional(),
  tags: z.array(FileProviderTagSchema).max(3).optional(),
};

export const FileProviderEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("folder"), ...entryFacts }).loose(),
  z
    .object({
      kind: z.literal("file"),
      ...entryFacts,
      size: z.number().int().min(0),
      mediaType: z.string().min(1).max(255).optional(),
    })
    .loose(),
]);

/** One folder page. Folders may be virtual; pages may be short or empty and still continue while `next` is set. */
export const FileProviderListDataSchema = z
  .object({
    writable: z.boolean(),
    items: z.array(FileProviderEntrySchema).max(100),
    next: CursorSchema.nullable(),
  })
  .loose();

export const FileProviderReadInputSchema = z
  .object({ id: ProviderIdSchema.describe("File ID returned by this provider's list.") })
  .strict();
export const FileProviderReadDataSchema = z.object({}).loose();

/** A single file name: no path separators, control characters, `.` or `..`. */
const FileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^(?!\.{1,2}$)[^/\\\u0000-\u001f\u007f]+$/);

export const FileProviderSaveInputSchema = z
  .object({
    parent: ProviderIdSchema.describe("Writable folder ID returned by this provider's list."),
    name: FileNameSchema.describe("Name of the new file."),
    mediaType: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[\x20-\x7e]+$/)
      .describe("Media type of the content."),
    size: z.number().int().min(0).describe("Exact byte count of the content."),
  })
  .strict();

/** `file` is present once the write stream completed; the call that opens the stream has no file yet. */
export const FileProviderSaveDataSchema = z
  .object({
    file: z
      .object({ id: ProviderIdSchema, name: z.string().min(1).max(255), size: z.number().int().min(0) })
      .loose()
      .optional(),
  })
  .loose();

/**
 * The error code `save` answers, with status `409`, when the name already
 * exists in the folder. Consumers ask for another name only on this code;
 * every other failure keeps its own code, even with status `409`.
 */
export const FILE_PROVIDER_NAME_CONFLICT = "FILE_NAME_CONFLICT";

/**
 * The three file-provider functions. `read` streams the file's bytes, `save`
 * is an idempotent Action with a write stream that only creates files: an
 * existing name fails with `FILE_PROVIDER_NAME_CONFLICT`.
 */
export const fileProvider = {
  list: { kind: "query", input: FileProviderListInputSchema, data: FileProviderListDataSchema },
  read: { kind: "query", input: FileProviderReadInputSchema, data: FileProviderReadDataSchema, stream: "read" },
  save: {
    kind: "action",
    idempotency: "required",
    input: FileProviderSaveInputSchema,
    data: FileProviderSaveDataSchema,
    stream: "write",
  },
} as const satisfies Record<string, CapabilityContract>;

export type FileProviderFunction = keyof typeof fileProvider;
export const FILE_PROVIDER_FUNCTIONS = ["list", "read", "save"] as const satisfies readonly FileProviderFunction[];

export type FileProviderTag = z.output<typeof FileProviderTagSchema>;
export type FileProviderEntry = z.output<typeof FileProviderEntrySchema>;
export type FileProviderListData = z.output<typeof FileProviderListDataSchema>;
export type FileProviderSaveData = z.output<typeof FileProviderSaveDataSchema>;

export type FileProviderIssue = CapabilityContractIssue & { function: FileProviderFunction; localId: string };

/**
 * Explains why a manifest's `fileProvider` declaration cannot serve the
 * contract. Apps run it at start and fail; Core runs it when it reads a live
 * manifest and ignores an invalid declaration. An empty list means valid or
 * not declared.
 */
export const fileProviderIssues = (manifest: CapabilityManifest): FileProviderIssue[] => {
  const declaration = manifest.fileProvider;
  if (!declaration) return [];
  return FILE_PROVIDER_FUNCTIONS.flatMap((name) => {
    const localId = declaration[name];
    if (localId === undefined) return [];
    const contract = fileProvider[name];
    const query = manifest.queries.find((operation) => operation.localId === localId);
    const action = manifest.actions.find((operation) => operation.localId === localId);
    const issues = query
      ? capabilityContractIssues(contract, { kind: "query", operation: query })
      : action
        ? capabilityContractIssues(contract, { kind: "action", operation: action })
        : [{ code: "kind" as const, path: "$", message: `No Query or Action named ${localId}` }];
    return issues.map((issue) => ({ ...issue, function: name, localId }));
  });
};
