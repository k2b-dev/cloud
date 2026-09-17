import { z } from "zod";

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
export const ConfigurationSchema = z.object({
  url: z.string().url().or(z.literal("")),
  cloud: AreaConfigurationSchema.extend({ autoCreate: z.boolean().default(false), autoArchive: z.boolean().default(true) }),
  freeipa: AreaConfigurationSchema,
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
export type BasesResult = { items: BaseSummary[]; issues: { area: Area; code: string }[] };
export type DirectoryResult = { base: BaseSummary; path: string; items: FileEntry[]; next: string | null };
export type DownloadLease = { url: string; method: "GET"; expires: string };
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
  state: "pending" | "archived" | "restored" | "deleted";
  createdAt: string;
  operationId: string | null;
  canRetry: boolean;
  canRestore: boolean;
  canDelete: boolean;
};
export type ArchivePage = { items: ArchiveEntry[]; next: string | null };
export type MaintenanceResult = { processed: number; archived: number; pending: number };
