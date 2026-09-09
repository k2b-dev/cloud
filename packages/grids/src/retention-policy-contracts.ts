import { PaginationQuerySchema, PaginationResponseSchema } from "@k2b/cloud/contracts";
import { z } from "zod";
import { ShortIdSchema } from "./contracts";

export const RETENTION_MIN_DAYS = 1;
export const RETENTION_MAX_DAYS = 36_500;
export const RETENTION_PREVIEW_LIMIT = 100;
const RETENTION_FILE_SEARCH_MAX_LENGTH = 100;
const RetentionFileStatusSchema = z.enum(["all", "retained", "reached"]);
export type RetentionFileStatus = z.infer<typeof RetentionFileStatusSchema>;
const RetentionRecordStatusSchema = z.enum(["all", "protected", "retained", "reached"]);
export type RetentionRecordStatus = z.infer<typeof RetentionRecordStatusSchema>;

export const RetentionPolicyInputSchema = z
  .object({ minimumDays: z.number().int().min(RETENTION_MIN_DAYS).max(RETENTION_MAX_DAYS) })
  .strict();
export type RetentionPolicyInput = z.infer<typeof RetentionPolicyInputSchema>;

const RetentionPolicySchema = z
  .object({ baseId: ShortIdSchema, minimumDays: z.number().int().positive(), updatedAt: z.string().datetime({ offset: true }) })
  .strict();
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

export const RetentionPolicyResponseSchema = z.object({ policy: RetentionPolicySchema.nullable() }).strict();

export const RetentionPreviewSchema = z
  .object({
    observedAt: z.string().datetime({ offset: true }),
    minimumDays: z.number().int().positive(),
    counts: z
      .object({
        trashedRecords: z.number().int().nonnegative(),
        floorReached: z.number().int().nonnegative(),
        retainedUntilLater: z.number().int().nonnegative(),
        protectedFinalized: z.number().int().nonnegative(),
      })
      .strict(),
    examples: z.array(
      z
        .object({
          recordId: ShortIdSchema,
          tableId: ShortIdSchema,
          deletedAt: z.string().datetime({ offset: true }),
          notBefore: z.string().datetime({ offset: true }),
        })
        .strict(),
    ),
    truncated: z.boolean(),
    files: z
      .object({
        counts: z
          .object({
            unreferenced: z.number().int().nonnegative(),
            floorReached: z.number().int().nonnegative(),
            retainedUntilLater: z.number().int().nonnegative(),
            sizeBytes: z.number().int().nonnegative(),
          })
          .strict(),
        examples: z.array(
          z
            .object({
              fileId: ShortIdSchema,
              filename: z.string(),
              sizeBytes: z.number().int().nonnegative(),
              unreferencedAt: z.string().datetime({ offset: true }),
              notBefore: z.string().datetime({ offset: true }),
            })
            .strict(),
        ),
        truncated: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type RetentionPreview = z.infer<typeof RetentionPreviewSchema>;

export const RetentionFilesQuerySchema = z
  .object({
    ...PaginationQuerySchema.shape,
    minimumDays: z.coerce.number().int().min(RETENTION_MIN_DAYS).max(RETENTION_MAX_DAYS),
    search: z.string().trim().max(RETENTION_FILE_SEARCH_MAX_LENGTH).optional().default(""),
    status: RetentionFileStatusSchema.optional().default("all"),
  })
  .strict();

const RetentionFileSchema = z
  .object({
    fileId: ShortIdSchema,
    filename: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    unreferencedAt: z.string().datetime({ offset: true }),
    notBefore: z.string().datetime({ offset: true }),
    status: z.enum(["retained", "reached"]),
  })
  .strict();
export type RetentionFile = z.infer<typeof RetentionFileSchema>;

export const RetentionFilesResponseSchema = z
  .object({
    observedAt: z.string().datetime({ offset: true }),
    minimumDays: z.number().int().positive(),
    items: z.array(RetentionFileSchema),
    pagination: PaginationResponseSchema,
  })
  .strict();
export type RetentionFilesResponse = z.infer<typeof RetentionFilesResponseSchema>;

export const RetentionRecordsQuerySchema = z
  .object({
    ...PaginationQuerySchema.shape,
    minimumDays: z.coerce.number().int().min(RETENTION_MIN_DAYS).max(RETENTION_MAX_DAYS),
    search: z.string().trim().max(RETENTION_FILE_SEARCH_MAX_LENGTH).optional().default(""),
    status: RetentionRecordStatusSchema.optional().default("all"),
  })
  .strict();

const RetentionRecordSchema = z
  .object({
    recordId: ShortIdSchema,
    tableId: ShortIdSchema,
    tableName: z.string(),
    deletedAt: z.string().datetime({ offset: true }),
    notBefore: z.string().datetime({ offset: true }).nullable(),
    status: z.enum(["protected", "retained", "reached"]),
  })
  .strict();
export type RetentionRecord = z.infer<typeof RetentionRecordSchema>;

export const RetentionRecordsResponseSchema = z
  .object({
    observedAt: z.string().datetime({ offset: true }),
    minimumDays: z.number().int().positive(),
    items: z.array(RetentionRecordSchema),
    pagination: PaginationResponseSchema,
  })
  .strict();
export type RetentionRecordsResponse = z.infer<typeof RetentionRecordsResponseSchema>;
