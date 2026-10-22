import { z } from "zod";
import {
  BASE_CREATION_POLICIES,
  BASE_STORE_OPERATIONS,
  BASE_STORE_STATES,
  READ_PROFILE_NAMES,
  WRITE_BLOCK_REASONS,
} from "./admin-contracts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const BaseLimitsSchema = z
  .object({
    queriesPerHour: positive.max(2147483647),
    valuesPerMinute: positive,
    bytesPerMinute: positive,
    storageBytes: positive,
    maxSeries: positive,
    maxEventKinds: positive,
    maxStateKeys: positive,
  })
  .strict();
export const PulsePolicySchema = z
  .object({
    baseCreation: z.enum(BASE_CREATION_POLICIES),
    maxBases: positive,
    maxRawRetentionDays: positive.max(3650),
    defaultProfile: z.enum(READ_PROFILE_NAMES),
    defaultLimits: BaseLimitsSchema,
  })
  .strict();
export const PulsePolicyUpdateSchema = PulsePolicySchema.omit({ defaultLimits: true })
  .partial()
  .extend({ defaultLimits: BaseLimitsSchema.partial().optional() })
  .strict();
export const BaseStoreStatusSchema = z.object({
  state: z.enum(BASE_STORE_STATES),
  operation: z.enum(BASE_STORE_OPERATIONS).nullable(),
  errorCode: z.string().nullable(),
  errorAt: z.string().nullable(),
  writeBlockReason: z.enum(WRITE_BLOCK_REASONS).nullable(),
  profile: z.enum(READ_PROFILE_NAMES),
  limits: BaseLimitsSchema,
  usage: z.object({ bytes: z.number(), rows: z.number(), measuredAt: z.string() }).nullable(),
});
export const LimitsUpdateSchema = z
  .object({ profile: z.enum(READ_PROFILE_NAMES).optional(), limits: BaseLimitsSchema.partial().optional() })
  .strict();
export const AdminBaseRowSchema = z.object({
  rollupLag: z.boolean(),
  id: z.string(),
  name: z.string(),
  admins: z.array(z.string()),
  adminCount: z.number(),
  rawRetentionDays: z.number(),
  rollupRetentionDays: z.number(),
  sensitiveRetentionHours: z.number(),
  createdAt: z.string(),
  store: BaseStoreStatusSchema,
});
