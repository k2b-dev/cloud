import { z } from "zod";
import {
  ACTIVITY_CHAIN_LIMIT,
  ACTIVITY_PAGE_LIMIT,
  type ActivityChain,
  type ActivityEntry,
  ActivityInput,
  type ActivityPage,
  type ActivitySide,
  HistoryAction,
  MovementChainInput,
  type ShareAccessCounts,
  ShareAccessInput,
  ShareAccessNetwork,
} from "./activity-contracts";

/** HTTP query strings convert only at the transport boundary; the reader owns all limits. */
export const ActivityQuery = ActivityInput.extend({ limit: z.coerce.number().optional().pipe(ActivityInput.shape.limit) });
export const ShareAccessParam = z.object({ shareId: ShareAccessInput.shape.shareId }).strict();
export const ShareAccessQuery = z
  .object({
    from: ShareAccessInput.shape.from,
    to: ShareAccessInput.shape.to,
    networkAfter: ShareAccessInput.shape.networkAfter,
    timelineAfter: ShareAccessInput.shape.timelineAfter,
    networkLimit: z.coerce.number().optional().pipe(ShareAccessInput.shape.networkLimit),
  })
  .strict();
export const ActivityIdInput = z.object({ activityId: z.uuid().describe("Activity UUID returned by activity.list.") }).strict();
export const MovementChainQuery = MovementChainInput.omit({ activityId: true });
const nullableId = z.string().nullable();
const observation = z.union([
  z.object({ state: z.literal("unavailable") }),
  z.object({
    exists: z.boolean(),
    directory: z.boolean().optional(),
    id: z.string().optional(),
    size: z.number().optional(),
    revision: z.string().optional(),
  }),
]);
export const ActivitySideSchema = z.discriminatedUnion("visibility", [
  z.object({ visibility: z.literal("hidden") }).strict(),
  z
    .object({
      visibility: z.literal("disappearance"),
      name: z.string(),
      path: z.string(),
      directory: z.boolean().nullable(),
      publicBaseId: nullableId,
      relativePath: nullableId.optional(),
    })
    .strict(),
  z
    .object({
      visibility: z.literal("full"),
      source: z.enum(["current", "snapshot"]),
      name: z.string(),
      path: z.string(),
      root: z.string(),
      baseId: nullableId,
      publicBaseId: nullableId,
      relativePath: nullableId.optional(),
      itemId: nullableId,
      directory: z.boolean(),
      size: z.number().nullable(),
      revision: nullableId,
      versionId: z.string().optional(),
      observation: observation.optional(),
    })
    .strict(),
]) satisfies z.ZodType<ActivitySide>;
export const ActivityEntrySchema = z
  .object({
    id: z.uuid(),
    action: HistoryAction,
    state: z.enum(["pending", "done", "failed", "not_done", "unclear"]),
    time: z.string(),
    startedAt: z.string(),
    finishedAt: nullableId,
    actor: z.object({ kind: z.enum(["user", "visitor", "system", "observed"]), userId: nullableId, name: nullableId }).strict(),
    via: z.string(),
    before: ActivitySideSchema,
    after: ActivitySideSchema,
    batchId: nullableId,
    share: z.object({ expiresAt: z.iso.datetime().nullable() }).strict().optional(),
    execution: z
      .object({ invocationId: nullableId, requestId: nullableId, callingApp: nullableId, origin: nullableId })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (entry) =>
      !entry.share ||
      ((entry.action === "share.create" || entry.action === "share.revoke") &&
        (entry.before.visibility === "full" || entry.after.visibility === "full")),
    "Share metadata requires an authorized full share event",
  ) satisfies z.ZodType<ActivityEntry>;
export const ActivityPageSchema = z
  .object({
    items: z.array(ActivityEntrySchema).max(ACTIVITY_PAGE_LIMIT),
    next: nullableId,
    visibleCount: z.number().int().nonnegative(),
    batches: z.array(z.object({ id: z.string(), visibleCount: z.number().int().nonnegative() }).strict()).max(ACTIVITY_PAGE_LIMIT),
    exhausted: z.boolean(),
    scanLimitReached: z.boolean(),
    searchLimitReached: z.boolean(),
  })
  .strict() satisfies z.ZodType<ActivityPage>;
export const ActivityChainSchema = z
  .object({
    sourceId: z.uuid(),
    hops: z
      .array(
        z
          .object({
            activityId: z.uuid(),
            time: z.string(),
            actor: ActivityEntrySchema.shape.actor,
            via: z.string(),
            before: ActivitySideSchema,
            after: ActivitySideSchema,
          })
          .strict(),
      )
      .max(ACTIVITY_CHAIN_LIMIT),
    endpoint: z.object({ baseId: z.string(), path: z.string(), itemId: nullableId }).strict().nullable(),
    certainty: z.enum(["verified", "probable", "unavailable"]),
    historyComplete: z.literal(false),
    truncated: z.boolean(),
  })
  .strict() satisfies z.ZodType<ActivityChain>;
export const ShareAccessCountsSchema = z
  .object({
    pageNetworks: z.number().int().nonnegative().nullable(),
    from: z.iso.date(),
    to: z.iso.date(),
    timeline: z
      .object({
        items: z
          .array(
            z
              .object({
                date: z.iso.datetime(),
                granularity: z.enum(["hour", "day"]),
                pages: z.number().int().nonnegative(),
                downloads: z.number().int().nonnegative(),
                passwordFailed: z.number().int().nonnegative(),
                knownNetworks: z.number().int().nonnegative().nullable(),
                overflow: z.boolean(),
              })
              .strict(),
          )
          .max(ACTIVITY_PAGE_LIMIT),
        next: z.iso.datetime().nullable(),
      })
      .strict(),
    pages: z.number().int().nonnegative(),
    downloads: z.number().int().nonnegative(),
    passwordFailed: z.number().int().nonnegative(),
    networks: z
      .object({
        known: z.number().int().nonnegative(),
        incomplete: z.boolean(),
        overflow: z.boolean(),
        items: z
          .array(
            z
              .object({
                network: ShareAccessNetwork,
                pages: z.number().int().nonnegative(),
                downloads: z.number().int().nonnegative(),
                passwordFailed: z.number().int().nonnegative(),
                firstSeen: z.iso.datetime(),
                lastSeen: z.iso.datetime(),
              })
              .strict(),
          )
          .max(ACTIVITY_PAGE_LIMIT),
        next: ShareAccessNetwork.nullable(),
        rolledUp: z.boolean(),
      })
      .strict(),
  })
  .strict() satisfies z.ZodType<ShareAccessCounts>;
