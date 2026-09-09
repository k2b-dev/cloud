import { z } from "zod";

const MAX_PATH_LENGTH = 4_096;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_BASE_ID_LENGTH = 255;
const SHA256_CHECKSUM_REGEX = /^sha256:[a-f0-9]{64}$/;

const PathSchema = z
  .string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .refine((value) => !value.includes("\0"), "Path must not contain null bytes");

const FileNameSchema = z
  .string()
  .min(1)
  .max(MAX_FILE_NAME_LENGTH)
  .refine((value) => value.trim().length > 0, "File name must not be blank")
  .refine((value) => value !== "." && value !== "..", "File name is reserved")
  .refine((value) => !value.includes("\0"), "File name must not contain null bytes")
  .refine((value) => !value.includes("/") && !value.includes("\\"), "File name must not contain path separators");

export const FileBaseTypeSchema = z.enum(["home", "group"]);

export const FileBaseParamSchema = z.object({
  baseType: FileBaseTypeSchema,
  baseId: z.string().min(1).max(MAX_BASE_ID_LENGTH),
});

export const UploadIdParamSchema = FileBaseParamSchema.extend({
  uploadId: z.string().min(1).max(255),
});

export const FilePathQuerySchema = z.object({
  path: PathSchema,
});

export const OptionalFilePathQuerySchema = z.object({
  path: PathSchema.default("/"),
});

export const DownloadQuerySchema = FilePathQuerySchema.extend({
  inline: z.coerce.boolean().optional(),
});

export const UploadHeaderSchema = z.object({
  "x-file-name": FileNameSchema,
});

export const ChunkHeaderSchema = z.object({
  "x-chunk-checksum": z.string().regex(SHA256_CHECKSUM_REGEX).optional(),
  "x-upload-ticket": z.string().describe("Ticket issued when the upload session was started"),
});

// Local Zod schemas for OpenAPI documentation (compatible with Filegate types)
export const FileTypeSchema = z.enum(["file", "directory"]);
export type FileType = z.infer<typeof FileTypeSchema>;

export const FileInfoSchema = z.object({
  name: z.string().describe("File or directory name"),
  path: z.string().describe("Relative path within base"),
  type: FileTypeSchema.describe("File type"),
  size: z.number().describe("Size in bytes (0 for directories)"),
  mtime: z.string().describe("Last modified time (ISO timestamp)"),
  isHidden: z.boolean().describe("Whether name starts with '.'"),
  mimeType: z.string().optional().describe("MIME type (only for files)"),
});
export type FileInfo = z.infer<typeof FileInfoSchema>;

export const DirectoryListingSchema = FileInfoSchema.extend({
  items: z.array(FileInfoSchema).describe("Directory contents"),
  total: z.number().describe("Total number of items"),
});
export type DirectoryListing = z.infer<typeof DirectoryListingSchema>;

// Response from /info endpoint - can be file info or directory listing
export const FileInfoResponseSchema = z.union([
  FileInfoSchema.extend({ type: z.literal("file") }),
  DirectoryListingSchema.extend({ type: z.literal("directory") }),
]);
export type FileInfoResponse = z.infer<typeof FileInfoResponseSchema>;

// Base types for home/group directories
export const FileBaseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("home"),
    uid: z.string().describe("User UID (login name)"),
    uidNumber: z.number().optional().describe("Numeric POSIX UID"),
    gidNumber: z.number().optional().describe("Numeric POSIX GID (primary group)"),
  }),
  z.object({
    type: z.literal("group"),
    groupId: z.string().describe("auth.groups UUID — the only identity access checks may compare"),
    name: z.string().describe("Group cn — the share directory name and URL segment, never an access check"),
    gidNumber: z.number().optional().describe("Numeric POSIX GID"),
  }),
]);
export type FileBase = z.infer<typeof FileBaseSchema>;

export const ListFilesQuerySchema = z.object({
  path: PathSchema.default("/").describe("Directory path to list"),
  showHidden: z.coerce.boolean().default(false).describe("Include hidden files"),
});

export const FileActionSchema = z.enum(["mkdir", "move", "copy"]);
export type FileAction = z.infer<typeof FileActionSchema>;

export const FileActionQuerySchema = z.object({
  action: FileActionSchema.describe("Action to perform"),
  path: PathSchema.describe("Source path"),
  to: PathSchema.optional().describe("Destination path (required for move/copy)"),
});

export const FileBaseInfoSchema = z.object({
  type: z.enum(["home", "group"]).describe("Base type"),
  id: z.string().describe("User UID or group name"),
  name: z.string().describe("Display name"),
});
export type FileBaseInfo = z.infer<typeof FileBaseInfoSchema>;

// === Search Schemas ===

export const GlobalSearchQuerySchema = z.object({
  pattern: z.string().min(1).max(500).describe("Glob pattern (e.g. '**/*.pdf', '*.{jpg,png}')"),
  bases: z
    .string()
    .max(4_000)
    .optional()
    .describe("Comma-separated base IDs to search (e.g. 'home:alice,group:devs'). Default: all accessible bases"),
  showHidden: z.coerce.boolean().default(false).describe("Include hidden files"),
  limit: z.coerce.number().int().min(1).max(100).default(100).describe("Max results per base"),
});

export const SearchResultSchema = z.object({
  base: FileBaseInfoSchema.describe("The base this result is from"),
  files: z.array(FileInfoSchema).describe("Matching files"),
  total: z.number().describe("Number of matches in this base"),
  hasMore: z.boolean().describe("Whether there are more results"),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const GlobalSearchResponseSchema = z.object({
  results: z.array(SearchResultSchema).describe("Results grouped by base"),
  totalFiles: z.number().describe("Total number of files found across all bases"),
});
export type GlobalSearchResponse = z.infer<typeof GlobalSearchResponseSchema>;

// === Chunked Upload Schemas ===

// Input schema for starting a chunked upload (API validation)
export const ChunkedUploadStartSchema = z.object({
  filename: FileNameSchema.describe("Name of the file to upload"),
  size: z.number().int().positive().describe("Total file size in bytes"),
  checksum: z.string().regex(SHA256_CHECKSUM_REGEX).describe("SHA-256 checksum of the entire file (format: sha256:<64 hex chars>)"),
  chunkSize: z.number().int().positive().describe("Size of each chunk in bytes"),
});
export type ChunkedUploadStart = z.infer<typeof ChunkedUploadStartSchema>;

// Response schema for chunked upload start (OpenAPI documentation)
export const ChunkedUploadStartResponseSchema = z.object({
  uploadId: z.string().describe("Unique upload session ID"),
  uploadTicket: z.string().describe("Proof that this session belongs to the authorized base; send as x-upload-ticket"),
  totalChunks: z.number().describe("Total number of chunks expected"),
  chunkSize: z.number().describe("Size of each chunk"),
  uploadedChunks: z.array(z.number()).describe("Already uploaded chunk indices (for resume)"),
  completed: z.literal(false),
});
export type ChunkedUploadStartResponse = z.infer<typeof ChunkedUploadStartResponseSchema>;

/** What filegate reports back; the API layer adds the ticket on top. */
export type ChunkedUploadSession = Omit<ChunkedUploadStartResponse, "uploadTicket">;

// Query schema for uploading a chunk
export const ChunkedUploadChunkQuerySchema = z.object({
  index: z.coerce.number().int().min(0).describe("Chunk index (0-based)"),
});

// Response schemas for chunk upload (OpenAPI documentation)
export const ChunkedUploadProgressSchema = z.object({
  chunkIndex: z.number().describe("Index of the chunk just uploaded"),
  uploadedChunks: z.array(z.number()).describe("All uploaded chunk indices"),
  completed: z.literal(false),
});
export type ChunkedUploadProgress = z.infer<typeof ChunkedUploadProgressSchema>;

export const ChunkedUploadCompleteSchema = z.object({
  completed: z.literal(true),
  file: FileInfoSchema.extend({
    checksum: z.string().describe("SHA-256 checksum of the completed file"),
  }),
});
export type ChunkedUploadComplete = z.infer<typeof ChunkedUploadCompleteSchema>;

export const ChunkedUploadResponseSchema = z.union([ChunkedUploadProgressSchema, ChunkedUploadCompleteSchema]);
export type ChunkedUploadResponse = z.infer<typeof ChunkedUploadResponseSchema>;

// === Move/Copy Target Search Schemas ===

export const MoveTargetSearchQuerySchema = z.object({
  query: z.string().max(200).default("").describe("Search query for directory names"),
  targetBaseType: z.enum(["home", "group"]).describe("Target base type to search in"),
  targetBaseId: z.string().min(1).max(MAX_BASE_ID_LENGTH).describe("Target base ID (uid for home, group name for group)"),
  limit: z.coerce.number().int().min(1).max(50).default(20).describe("Max results"),
});
export type MoveTargetSearchQuery = z.infer<typeof MoveTargetSearchQuerySchema>;

export const MoveTargetResultSchema = z.object({
  path: z.string().describe("Directory path within base"),
  name: z.string().describe("Directory name"),
});
export type MoveTargetResult = z.infer<typeof MoveTargetResultSchema>;

export const MoveTargetSearchResponseSchema = z.object({
  directories: z.array(MoveTargetResultSchema).describe("Matching directories"),
  total: z.number().describe("Total matches found"),
});
export type MoveTargetSearchResponse = z.infer<typeof MoveTargetSearchResponseSchema>;

// === Transfer (Move/Copy) Schemas ===

export const TransferRequestSchema = z.object({
  paths: z.array(PathSchema).min(1).max(100).describe("Source paths to transfer"),
  targetBaseType: z.enum(["home", "group"]).describe("Destination base type"),
  targetBaseId: z.string().min(1).max(MAX_BASE_ID_LENGTH).describe("Destination base ID"),
  targetPath: PathSchema.describe("Destination directory path"),
});
export type TransferRequest = z.infer<typeof TransferRequestSchema>;

export const TransferErrorSchema = z.object({
  path: z.string().describe("Source path that failed"),
  error: z.string().describe("Error message"),
});

export const TransferResultSchema = z.object({
  moved: z.boolean().describe("True if move, false if copy"),
  transferred: z.number().describe("Items transferred successfully"),
  errors: z.array(TransferErrorSchema).describe("Transfer errors"),
});
export type TransferResult = z.infer<typeof TransferResultSchema>;

// === Duplicate Schema ===

export const DuplicateRequestSchema = z.object({
  path: PathSchema.describe("Source file/folder path"),
  newName: FileNameSchema.describe("New name for the duplicate"),
});
export type DuplicateRequest = z.infer<typeof DuplicateRequestSchema>;

export { ErrorResponseSchema, hasRole } from "@k2b/cloud/contracts";
export type { MutationResult, User } from "@k2b/cloud/contracts";
