import { z } from "zod";
import { DOCUMENT_FORMATS, DOCUMENT_KINDS, type DocumentFormat } from "./documents";

export const AreaSchema = z.enum(["cloud", "freeipa"]);
export type Area = z.infer<typeof AreaSchema>;
export const KindSchema = z.enum(["users", "groups"]);
export type BaseKind = z.infer<typeof KindSchema>;
export const AreaConfigurationSchema = z.object({
  enabled: z.boolean(),
  root: z.string().min(1).max(128),
  prefix: z.string().max(1024),
  homes: z.string().min(1).max(1024),
  groups: z.string().min(1).max(1024),
  archive: z.string().min(1).max(1024),
});
export const DocumentFormatSchema = z.enum(DOCUMENT_FORMATS);
export const DocumentKindSchema = z.enum(DOCUMENT_KINDS);
/** Collabora Online: `url` is what browsers load; `internalUrl` and `wopiOrigin` only matter when servers reach each other differently. */
export const CollaboraConfigurationSchema = z.object({
  url: z.string().url().or(z.literal("")).default(""),
  internalUrl: z.string().url().or(z.literal("")).default(""),
  wopiOrigin: z.string().url().or(z.literal("")).default(""),
  documentFormat: DocumentFormatSchema.default("odf"),
});
export const ConfigurationSchema = z.object({
  url: z.string().url().or(z.literal("")),
  cloud: AreaConfigurationSchema.extend({ autoCreate: z.boolean().default(false), autoArchive: z.boolean().default(true) }),
  freeipa: AreaConfigurationSchema,
  collabora: CollaboraConfigurationSchema.default({ url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" }),
});
export const ConfigurationInputSchema = ConfigurationSchema.extend({ token: z.string().max(4096).optional() });
export type Configuration = z.infer<typeof ConfigurationSchema>;
export type ConfigurationInput = z.infer<typeof ConfigurationInputSchema>;
export type PublicConfiguration = Configuration & { tokenConfigured: boolean };
export type Availability = { localLinuxEnabled: boolean; freeipaEnabled: boolean };
export const InventoryStateSchema = z.enum(["existing", "missing", "unassigned", "conflict", "unknown", "orphaned", "retired"]);
export type InventoryState = z.infer<typeof InventoryStateSchema>;
export type BaseSummary = {
  id: string;
  area: Area;
  kind: BaseKind;
  name: string;
  status: InventoryState;
  reason: string | null;
  indexEnabled: boolean;
  versioningEnabled: boolean;
};
export type FileEntry = { name: string; path: string; directory: boolean; size: number; modified: string };
/** Present when an administrator configured Collabora; the browser then offers editing and new documents. */
export type EditorInfo = { documentFormat: DocumentFormat };
export type BasesResult = { items: BaseSummary[]; issues: { area: Area; code: string }[]; editor: EditorInfo | null };
export type DirectoryResult = { base: BaseSummary; path: string; items: FileEntry[]; next: string | null };
export type DownloadLease = { url: string; method: "GET"; expires: string };
export type EntryResult = { base: BaseSummary; entry: FileEntry };
export const EntryQuerySchema = z.object({ path: z.string().min(1).max(4096) });
export const ThumbnailInputSchema = EntryQuerySchema.extend({ size: z.enum(["small", "large"]).default("small") });
export type SearchResult = DirectoryResult & { query: string; scope: "folder" | "tree" };
export const DirectoryInputSchema = z.object({ path: z.string().min(1).max(4096) });
export const UploadInputSchema = z.object({
  path: z.string().min(1).max(4096),
  size: z.number().int().min(0),
  onConflict: z.enum(["error", "overwrite"]).default("error"),
});
export const UploadIdSchema = z.object({ id: z.string().min(1).max(256) });
/** Browser and CLI transfer segments straight to `url`; Cloud never sees the bytes. */
export type UploadSession = { id: string; path: string; size: number; chunkSize: number; url: string; expires: string };
export type UploadLease = { url: string; expires: string };
const PathSchema = z.string().min(1).max(4096);
/** A selection never exceeds two listing pages. */
const PathsSchema = z.array(PathSchema).min(1).max(100);
export const RenameInputSchema = z.object({ path: PathSchema, name: z.string().min(1).max(255) });
export const MoveInputSchema = z.object({ paths: PathsSchema, folder: z.string().max(4096) });
export const CopyInputSchema = z.object({ paths: PathsSchema, targetBaseId: z.string().min(1), folder: z.string().max(4096) });
export const PathsInputSchema = z.object({ paths: PathsSchema });
export const TrashIdSchema = z.object({ id: z.string().uuid() });
export const CreateDocumentInputSchema = z.object({ path: PathSchema, kind: DocumentKindSchema });
/** Everything the browser needs to load one file into Collabora; the token is bound to this user and file. */
export type EditorLaunch = { base: BaseSummary; entry: FileEntry; action: string; token: string; tokenTtl: number; canWrite: boolean };
export const VersionRefSchema = z.object({ path: PathSchema, id: z.string().min(1).max(128) });
export const VersionCommentSchema = VersionRefSchema.extend({ comment: z.string().trim().max(2000) });
export const VersionRestoreAsSchema = VersionRefSchema.extend({ name: z.string().min(1).max(255) });
export type FileVersion = { id: string; created: string; size: number; pinned: boolean; comment: string | null; author: string | null };
export type TrashEntry = { id: string; original: string; name: string; directory: boolean; deletedAt: string };
export type EntriesResult = { base: BaseSummary; entries: FileEntry[] };
export type ArchiveDownload = { url: string; method: "POST"; expires: string; manifest: string };
export const ShareValiditySchema = z.enum(["1d", "7d", "30d", "90d"]);
export const CreateShareInputSchema = z.object({
  kind: z.enum(["download", "inbox"]),
  paths: z.array(PathSchema).max(100).default([]),
  folder: z.string().max(4096).default(""),
  title: z.string().trim().min(1).max(200),
  note: z.string().trim().max(500).optional(),
  expiresIn: ShareValiditySchema.default("30d"),
});
export const ShareIdSchema = z.object({ id: z.string().uuid() });
export type ShareView = {
  id: string;
  kind: "download" | "inbox";
  url: string;
  title: string;
  note: string | null;
  base: { id: string; name: string };
  scope: string;
  items: string[];
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  state: "active" | "expired" | "revoked";
  accessCount: number;
  lastAccessedAt: string | null;
};
export const PublicUploadInputSchema = z.object({ name: z.string().min(1).max(255), size: z.number().int().min(0) });
export type PublicShare = {
  kind: "download" | "inbox";
  title: string;
  expiresAt: string;
  items: { path: string; name: string; directory: boolean; size: number }[];
};
export type RootSummary = {
  name: string;
  indexEnabled: boolean;
  versioningEnabled: boolean;
  files: number | null;
  directories: number | null;
  bytes: number | null;
  versions: number;
  versionBytes: number;
  activeUploads: number;
  available: number;
  capacity: number;
};
export type InventoryEntry = {
  identityId: string | null;
  name: string;
  path: string;
  kind: BaseKind;
  area: Area;
  status: InventoryState;
  reason: string | null;
  baseId: string | null;
  operationId: string | null;
  uid: number | null;
  gid: number | null;
  actions: DirectoryActions;
};
export type AdminResult = {
  configuration: PublicConfiguration;
  availability: Availability;
  root: RootSummary | null;
  items: InventoryEntry[];
  next: string | null;
  issue: string | null;
};
export const BrowseQuerySchema = z.object({ path: z.string().max(4096).default(""), after: z.string().max(4096).optional() });
export const DownloadInputSchema = z.object({ path: z.string().min(1).max(4096) });
export const SearchQuerySchema = BrowseQuerySchema.extend({
  q: z.string().trim().min(1).max(256),
  /** Filegate always searches the subtree; "folder" keeps only direct children of the searched folder. */
  scope: z.enum(["folder", "tree"]).default("tree"),
});
export const AdminQuerySchema = z.object({
  area: AreaSchema.default("cloud"),
  kind: KindSchema.default("users"),
  includeEntries: z.enum(["true", "false"]).default("true"),
  after: z.string().max(8192).optional(),
  q: z.string().max(200).optional(),
  status: InventoryStateSchema.optional(),
});
export const AdoptInputSchema = z.object({ area: AreaSchema, kind: KindSchema, identityId: z.string().uuid() });
export const ErrorSchema = z.object({ code: z.string(), message: z.string() });

export type DirectoryActions = { create: boolean; adopt: boolean; archive: boolean; browse: boolean; delete: boolean; retire: boolean };
export const DirectoryIdentitySchema = z.object({ area: AreaSchema, kind: KindSchema, identityId: z.string().uuid() });
export const DirectoryTargetSchema = z.object({ area: AreaSchema, kind: KindSchema, name: z.string().min(1).max(255) });
export const ArchiveInputSchema = DirectoryTargetSchema.extend({ archivePath: z.string().min(1).max(1024).optional() });
export const DeleteDirectorySchema = DirectoryTargetSchema.extend({ confirmPath: z.string().min(1).max(4096) });
export const ConfirmPathSchema = z.object({ confirmPath: z.string().min(1).max(4096) });
export const ArchiveQuerySchema = z.object({ area: AreaSchema, after: z.string().uuid().optional(), q: z.string().max(200).optional() });
export const AdminLocatorSchema = z.object({
  area: AreaSchema,
  kind: KindSchema.optional(),
  name: z.string().min(1).max(255).optional(),
  archiveId: z.string().uuid().optional(),
  path: z.string().max(4096).default(""),
});
export const AdminBrowseSchema = AdminLocatorSchema.extend({ after: z.string().max(4096).optional() });
export const AdminDeleteSchema = AdminLocatorSchema.extend({ confirmPath: z.string().min(1).max(4096) });
export const RootActionSchema = z.object({ area: AreaSchema });
export type DirectoryTarget = z.infer<typeof DirectoryTargetSchema>;
export type AdminLocator = z.infer<typeof AdminLocatorSchema>;
export type AdminBrowseResult = {
  area: Area;
  kind: BaseKind;
  name: string;
  archiveId: string | null;
  basePath: string;
  path: string;
  items: FileEntry[];
  next: string | null;
};
export type OperationResult = { id: string; state: "complete" | "pending"; path: string };
export type ArchiveEntry = {
  id: string;
  area: Area;
  kind: BaseKind;
  name: string;
  originalPath: string;
  path: string;
  state: "pending" | "archived";
  createdAt: string;
  operationId: string | null;
  canRetry: boolean;
  canRestore: boolean;
  canDelete: boolean;
};
export type ArchivePage = { items: ArchiveEntry[]; next: string | null };
export type MaintenanceResult = { processed: number; archived: number; pending: number };
