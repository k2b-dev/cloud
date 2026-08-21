import { z } from "zod";
import { type Field, RecordAuditContextSchema, ShortIdSchema } from "../contracts";
import type { CombinedAuditPage } from "../service/combined-audit";
import { projectPublicIds } from "../service/public-resources";
import {
  isRecordHistoryAction,
  projectRecordHistoryEntry,
  type RecordHistoryAction,
  type RecordHistoryEntry,
} from "../service/record-history";

const RecordAuditActionSchema = z.custom<RecordHistoryAction>(
  (value) => typeof value === "string" && isRecordHistoryAction(value),
  "Unknown Record history action",
);
const PublicAuditDiffSchema = z.record(ShortIdSchema, z.object({ old: z.unknown(), new: z.unknown() }).strict());
const AuditSourceSchema = z
  .object({
    ref: z.string(),
    baseName: z.string(),
    tableName: z.string(),
  })
  .strict();
const CombinedAuditContextSchema = z
  .object({
    operation: z.enum(["delete", "restore", "update"]),
    answers: z.array(
      z
        .object({
          label: z.string(),
          type: z.enum(["text", "longtext", "select"]),
          required: z.boolean(),
          value: z.string(),
          optionLabel: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

const PublicAuditEntryShape = {
  // Audit entries and actors belong to the audit/auth domains and retain their UUID identity.
  id: z.string().uuid(),
  baseId: ShortIdSchema.nullable(),
  tableId: ShortIdSchema.nullable(),
  recordId: ShortIdSchema.nullable(),
  userId: z.string().uuid().nullable(),
  action: RecordAuditActionSchema,
  diff: PublicAuditDiffSchema.nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  userDisplayName: z.string().nullable().optional(),
  userAvatarHash: z.string().nullable().optional(),
};

export const PublicRecordAuditEntrySchema = z.object({ ...PublicAuditEntryShape, context: RecordAuditContextSchema.nullable() }).strict();
export const PublicCombinedAuditEntrySchema = z
  .object({
    ...PublicAuditEntryShape,
    context: CombinedAuditContextSchema.nullable(),
    source: AuditSourceSchema,
    recordDeletedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export const PublicRecordHistoryEntrySchema = z.union([PublicRecordAuditEntrySchema, PublicCombinedAuditEntrySchema]);
export const PublicCombinedAuditPageSchema = z
  .object({
    items: z.array(PublicCombinedAuditEntrySchema),
    sources: z.array(AuditSourceSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type PublicRecordHistoryEntry = z.infer<typeof PublicRecordHistoryEntrySchema>;
export type PublicCombinedAuditPage = z.infer<typeof PublicCombinedAuditPageSchema>;

type ProjectIds = typeof projectPublicIds;

const relationRecordIds = (entries: readonly RecordHistoryEntry[], fieldsById: ReadonlyMap<string, Field>) =>
  entries.flatMap((entry) =>
    Object.entries(entry.diff ?? {}).flatMap(([fieldId, change]) => {
      if (fieldsById.get(fieldId)?.type !== "relation") return [];
      return [change.old, change.new].flatMap((value) =>
        Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : [],
      );
    }),
  );

export const toPublicAuditEntries = async (
  entries: readonly RecordHistoryEntry[],
  fields: readonly Field[],
  projectIds: ProjectIds = projectPublicIds,
): Promise<PublicRecordHistoryEntry[]> => {
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const [bases, tables, records, relatedRecords] = await Promise.all([
    projectIds(
      "base",
      entries.flatMap((entry) => (entry.baseId ? [entry.baseId] : [])),
    ),
    projectIds(
      "table",
      entries.flatMap((entry) => (entry.tableId ? [entry.tableId] : [])),
    ),
    projectIds(
      "record",
      entries.flatMap((entry) => (entry.recordId ? [entry.recordId] : [])),
    ),
    projectIds("record", relationRecordIds(entries, fieldsById)),
  ]);

  return entries.map((entry) => {
    const diff = entry.diff
      ? Object.fromEntries(
          Object.entries(entry.diff).flatMap(([fieldId, change]) => {
            const field = fieldsById.get(fieldId);
            if (!field) return [];
            const projectValue = (value: unknown): unknown => {
              if (field.type !== "relation") return value;
              if (Array.isArray(value)) {
                return value.flatMap((item) => {
                  if (typeof item !== "string") return [item];
                  const publicId = relatedRecords.get(item);
                  return publicId ? [publicId] : [];
                });
              }
              return typeof value === "string" ? (relatedRecords.get(value) ?? null) : value;
            };
            return [[field.shortId, { old: projectValue(change.old), new: projectValue(change.new) }]];
          }),
        )
      : null;
    const common = {
      id: entry.id,
      baseId: entry.baseId ? (bases.get(entry.baseId) ?? null) : null,
      tableId: entry.tableId ? (tables.get(entry.tableId) ?? null) : null,
      recordId: entry.recordId ? (records.get(entry.recordId) ?? null) : null,
      userId: entry.userId,
      action: entry.action,
      diff,
      ip: entry.ip,
      userAgent: entry.userAgent,
      createdAt: entry.createdAt,
      userDisplayName: "userDisplayName" in entry ? entry.userDisplayName : undefined,
      userAvatarHash: "userAvatarHash" in entry ? entry.userAvatarHash : undefined,
    };
    return "source" in entry
      ? PublicCombinedAuditEntrySchema.parse({
          ...common,
          context: entry.context,
          source: entry.source,
          recordDeletedAt: entry.recordDeletedAt,
        })
      : PublicRecordAuditEntrySchema.parse({ ...common, context: entry.context });
  });
};

export const toPublicCombinedAuditPage = async (
  page: CombinedAuditPage,
  fields: readonly Field[],
  projectIds: ProjectIds = projectPublicIds,
): Promise<PublicCombinedAuditPage> =>
  PublicCombinedAuditPageSchema.parse({
    items: await toPublicAuditEntries(
      page.items.flatMap((entry) => {
        const projected = projectRecordHistoryEntry(entry);
        return projected ? [projected] : [];
      }),
      fields,
      projectIds,
    ),
    sources: page.sources,
    nextCursor: page.nextCursor,
  });
