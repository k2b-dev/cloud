import { z } from "zod";
import { KindSchema } from "./contracts";

/** Read contract is independent of the writer's staged action rollout. Unknown actions fail closed. */
export const HistoryAction = z.enum([
  "folder.create",
  "item.rename",
  "item.move",
  "item.copy",
  "file.upload",
  "file.overwrite",
  "file.create",
  "file.edit",
  "version.comment",
  "version.restore",
  "version.restore_copy",
  "version.delete",
  "item.trash",
  "item.restore",
  "item.purge",
  "share.create",
  "share.revoke",
  "place.retire",
  "place.provision",
  "place.archive",
  "place.restore",
  "admin.read",
  "item.differs",
  "item.elsewhere",
  "item.missing",
]);
export type HistoryAction = z.infer<typeof HistoryAction>;
export const ACTIVITY_PAGE_LIMIT = 50;
export const ACTIVITY_SCAN_LIMIT = 500;
export const ACTIVITY_SEARCH_LIMIT = 200;
export const ACTIVITY_CHAIN_LIMIT = 20;
export const ActivityInput = z
  .object({
    baseId: z.string().max(256).optional(),
    itemId: z.string().max(4096).optional(),
    path: z.string().max(4096).optional(),
    scope: z.enum(["item", "folder"]).default("item"),
    q: z.string().trim().min(1).max(4096).optional(),
    actor: z.uuid().optional(),
    action: HistoryAction.optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    cursor: z.string().max(16384).optional(),
    limit: z.number().int().min(1).max(ACTIVITY_PAGE_LIMIT).default(ACTIVITY_PAGE_LIMIT),
  })
  .strict();
export type ActivityInput = z.input<typeof ActivityInput>;
export type ActivityObservation =
  | { state: "unavailable" }
  | { exists: boolean; directory?: boolean; id?: string; size?: number; revision?: string };
export type ActivitySide =
  | { visibility: "hidden" }
  | {
      visibility: "disappearance";
      name: string;
      path: string;
      directory: boolean | null;
      /** Display metadata only; disappearance never authorizes an item action. */
      publicBaseId: string | null;
      relativePath?: string | null;
    }
  | {
      visibility: "full";
      /** Snapshot never implies current access, nor a current navigation target. Paths are Filegate-root relative. */
      source: "current" | "snapshot";
      name: string;
      path: string;
      root: string;
      baseId: string | null;
      publicBaseId: string | null;
      /** Base-relative display path approved with this side or its current binding. Never grants item access. */
      relativePath?: string | null;
      itemId: string | null;
      directory: boolean;
      size: number | null;
      revision: string | null;
      versionId?: string;
      observation?: ActivityObservation;
    };
export type ActivityEntry = {
  id: string;
  action: HistoryAction;
  state: "pending" | "done" | "failed" | "not_done" | "unclear";
  time: string;
  startedAt: string;
  finishedAt: string | null;
  actor: { kind: "user" | "visitor" | "system" | "observed"; userId: string | null; name: string | null };
  via: string;
  before: ActivitySide;
  after: ActivitySide;
  batchId: string | null;
  /** Immutable expiry from the retained share row; missing row or no expiry is null. Only share actions with a full side. */
  share?: { expiresAt: string | null };
  /** Only full visibility carries execution references. No credentials or arbitrary detail. */
  execution?: { invocationId: string | null; requestId: string | null; callingApp: string | null; origin: string | null };
};
export type ActivityPage = {
  items: ActivityEntry[];
  next: string | null;
  /** Counts describe this projected page only, never the underlying batch or database total. */
  visibleCount: number;
  batches: { id: string; visibleCount: number }[];
  exhausted: boolean;
  /** The scan budget interrupted filling this page, rather than the page/search limit ending it. */
  scanLimitReached: boolean;
  searchLimitReached: boolean;
};
export type ActivityChain = {
  sourceId: string;
  hops: { activityId: string; time: string; actor: ActivityEntry["actor"]; via: string; before: ActivitySide; after: ActivitySide }[];
  endpoint: { baseId: string; path: string; itemId: string | null } | null;
  certainty: "verified" | "probable" | "unavailable";
  /** Bounded history cannot prove the absence of retention gaps or external changes. */
  historyComplete: false;
  truncated: boolean;
};
/** Only canonical shortened writer keys; never a client address, sentinel, or arbitrary cursor. */
export const ShareAccessNetwork = z
  .string()
  .max(43)
  .refine((network) => {
    if (network.endsWith("/24")) {
      const address = network.slice(0, -3);
      return z.ipv4().safeParse(address).success && address.endsWith(".0");
    }
    if (!network.endsWith("/48")) return false;
    const address = network.slice(0, -3);
    return (
      z.ipv6().safeParse(address).success &&
      address.endsWith("::") &&
      address.split(":").filter(Boolean).length <= 3 &&
      new URL(`http://[${address}]/`).hostname === `[${address}]`
    );
  }, "Expected a canonical IPv4 /24 or IPv6 /48 network");
export const ShareAccessInput = z
  .object({
    shareId: z.uuid(),
    from: z.iso.date(),
    to: z.iso.date(),
    networkAfter: ShareAccessNetwork.optional(),
    timelineAfter: z.iso.datetime().optional(),
    networkLimit: z.number().int().min(1).max(50).default(50),
  })
  .strict()
  // Inclusive UTC dates: at most 3650 days, including both endpoints.
  .refine((input) => {
    const days = (Date.parse(input.to) - Date.parse(input.from)) / 86_400_000;
    return days >= 0 && days < 3650;
  }, "Expected an inclusive date window of at most 3650 days");
export type ShareAccessInput = z.input<typeof ShareAccessInput>;
export type ShareAccessPeriod = {
  /** UTC bucket start, never an individual request timestamp. */
  date: string;
  granularity: "hour" | "day";
  pages: number;
  downloads: number;
  passwordFailed: number;
  /** Null for daily aggregates or accesses without a classified network. */
  knownNetworks: number | null;
  /** Evidence of overflow in retained hourly data; daily rollups do not retain this evidence. */
  overflow: boolean;
};
export type ShareAccessCounts = {
  /** Inclusive UTC calendar dates selected by the caller. */
  from: string;
  to: string;
  timeline: { items: ShareAccessPeriod[]; next: string | null };
  /** Exact distinct networks with page views, or null when those identities are incomplete. */
  pageNetworks: number | null;
  pages: number;
  downloads: number;
  passwordFailed: number;
  networks: {
    /** Distinct known networks in retained hourly buckets, independent of this page. */
    known: number;
    /** Expired, rolled-up or unclassified accesses prevent an exact period network count. */
    incomplete: boolean;
    overflow: boolean;
    items: {
      network: string;
      pages: number;
      downloads: number;
      passwordFailed: number;
      /** First/last retained hourly bucket, not precise request timestamps. */
      firstSeen: string;
      lastSeen: string;
    }[];
    next: string | null;
    /** Daily totals carry no network cardinality or identity. */
    rolledUp: boolean;
  };
};

/** Recorded public binding identities, including archived bases; never storage inventory. */
export const ActivityBasesInput = z
  .object({
    q: z.string().trim().min(1).max(4096).optional(),
    after: z
      .string()
      .max(256)
      .refine((value) => {
        const [area, kind, id, extra] = value.split(":");
        return (
          (area === "cloud" || area === "freeipa") &&
          (kind === "users" || kind === "groups") &&
          z.uuid().safeParse(id).success &&
          extra === undefined
        );
      }, "Expected a public base ID")
      .optional(),
  })
  .strict();
export type ActivityBasesInput = z.input<typeof ActivityBasesInput>;
export const ActivityBasesPageSchema = z
  .object({
    items: z.array(z.object({ id: z.string(), name: z.string(), kind: KindSchema }).strict()).max(ACTIVITY_PAGE_LIMIT),
    next: z.string().nullable(),
  })
  .strict();
export type ActivityBasesPage = z.infer<typeof ActivityBasesPageSchema>;
