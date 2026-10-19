/**
 * Shapes shared by the per-base store service, the API, the CLI and the browser pages. Keep this module
 * free of imports: the admin and workspace islands bundle it for the browser.
 */

/** Lifecycle of a base's ClickHouse database. Writes are allowed only in `active`. */
export const BASE_STORE_STATES = ["provisioning", "active", "clearing", "deleting", "failed"] as const;
export type BaseStoreState = (typeof BASE_STORE_STATES)[number];

/** The operation a base is running, or the one that failed and "Retry" resumes. */
export const BASE_STORE_OPERATIONS = ["provision", "clear", "delete"] as const;
export type BaseStoreOperation = (typeof BASE_STORE_OPERATIONS)[number];

/** Fixed read profiles from the setup script: small 1 GB/10 s, normal 2 GB/10 s, large 4 GB/30 s. */
export const READ_PROFILE_NAMES = ["small", "normal", "large"] as const;
export type ReadProfileName = (typeof READ_PROFILE_NAMES)[number];

/** Who may create a base: every person and agent, only people, or only Cloud admins. */
export const BASE_CREATION_POLICIES = ["everyone", "people", "admins"] as const;
export type BaseCreationPolicy = (typeof BASE_CREATION_POLICIES)[number];

/** Why writes into a base are blocked after the hourly checkpoint comparison. */
export const WRITE_BLOCK_REASONS = ["checkpoint_mismatch", "database_missing"] as const;
export type WriteBlockReason = (typeof WRITE_BLOCK_REASONS)[number];

export type BaseLimits = {
  /** Samples + events + states per minute (enforced at ingest from slice 3). */
  valuesPerMinute: number;
  bytesPerMinute: number;
  /** Storage threshold; measured every 5 minutes from system.parts. */
  storageBytes: number;
  maxSeries: number;
  maxEventKinds: number;
  maxStateKeys: number;
};

export type BaseUsage = { bytes: number; rows: number; measuredAt: string };

/** What a base admin and the Cloud admin see about a base's store: amounts and state, never contents. */
export type BaseStoreStatus = {
  state: BaseStoreState;
  /** Running operation, or the failed one when `state` is `failed`; null when idle. */
  operation: BaseStoreOperation | null;
  /** Fixed code only (for example `STORE_UNREACHABLE`, `CLICKHOUSE_ERROR:241`, `STORE_NOT_PROVISIONED`). */
  errorCode: string | null;
  errorAt: string | null;
  writeBlockReason: WriteBlockReason | null;
  profile: ReadProfileName;
  limits: BaseLimits;
  usage: BaseUsage | null;
};

export type PulsePolicy = {
  baseCreation: BaseCreationPolicy;
  maxBases: number;
  maxRawRetentionDays: number;
  defaultProfile: ReadProfileName;
  defaultLimits: BaseLimits;
};
export type PulsePolicyUpdate = Partial<Omit<PulsePolicy, "defaultLimits">> & { defaultLimits?: Partial<BaseLimits> };

export type AdminBaseRow = {
  /** Public short ID. */
  id: string;
  name: string;
  /** Display names of up to three base admins, then `adminCount` for the rest. */
  admins: string[];
  adminCount: number;
  rawRetentionDays: number;
  rollupRetentionDays: number;
  sensitiveRetentionHours: number;
  createdAt: string;
  store: BaseStoreStatus;
};

export type InstanceDisk = { freeBytes: number; totalBytes: number; measuredAt: string };

export type AdminBasesPage = {
  items: AdminBaseRow[];
  total: number;
  nextOffset: number | null;
  /** Measured storage of all bases that are not being deleted, not only of this page. */
  usedBytes: number;
  /** Free space of the ClickHouse instance, from system.disks; null before the first measurement. */
  disk: InstanceDisk | null;
};

/** A `pulse_<hex>` database in ClickHouse without a base ("verwaist"). */
export type OrphanDatabase = { database: string };
export type OrphanDatabasesPage = { items: OrphanDatabase[]; nextOffset: number | null };

/** `host`: every port of a host; `host_port`: exactly one port; `network`: a CIDR range, every port. */
export const INTERNAL_TARGET_SCOPES = ["host", "host_port", "network"] as const;
export type InternalTargetScope = (typeof INTERNAL_TARGET_SCOPES)[number];

export type InternalTarget = {
  id: string;
  /** Public short ID of the base. */
  baseId: string;
  baseName: string;
  /** Normalized entry: `web-01`, `shop-01:9100`, `10.20.0.5:9100`, `[fd00::5]:9100` or `10.20.0.0/24`. */
  entry: string;
  scope: InternalTargetScope;
  /** The port of a `host_port` entry. */
  port: number | null;
  createdAt: string;
};
export type InternalTargetsPage = { items: InternalTarget[]; total: number; nextOffset: number | null };

/** 409 body when a shorter retention needs confirmation: the cutoff and amount each change removes. */
export type RetentionPreviewItem = {
  kind: "raw" | "rollup" | "sensitive";
  /** New retention in days (raw, rollup) or hours (sensitive). */
  retention: number;
  /** Data older than this ISO instant goes. */
  cutoff: string;
  rows: number;
  bytes: number;
};
export type RetentionConfirmationRequired = {
  code: "PULSE_RETENTION_CONFIRMATION_REQUIRED";
  message: string;
  preview: RetentionPreviewItem[];
};

/** Fixed codes the Pulse admin API answers with as `{ code }`. */
export const ADMIN_ERROR_CODES = [
  "ACCESS_DENIED",
  "INVALID_INPUT",
  "NOT_FOUND",
  "STORE_NOT_CONFIGURED",
  "STORE_UNAVAILABLE",
  "BASE_BUSY",
  "INVALID_TARGET",
  "TARGET_TOO_BROAD",
  "TARGET_EXISTS",
  "ORPHAN_IN_USE",
  "ADMIN_REQUEST_FAILED",
] as const;
export type AdminErrorCode = (typeof ADMIN_ERROR_CODES)[number];
