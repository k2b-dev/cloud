import { z } from "zod";
import { ShortIdSchema } from "../contracts";
import type { DurableHistoryStatus, RecordRevision } from "../service/durable-history";
import { projectPublicIds } from "../service/public-resources";
import { PublicFieldSchema, toPublicFields } from "./public-dto";

export const PublicDurableHistoryStatusSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      status: z.enum(["activating", "active"]),
      activatedAt: z.string().datetime(),
      baselineCompletedAt: z.string().datetime().nullable(),
      baseline: z.object({ captured: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict(),
    })
    .strict(),
]);

const PublicRevisionFileSchema = z
  .object({
    id: ShortIdSchema,
    fieldId: ShortIdSchema,
    position: z.number().int().nonnegative(),
    filename: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string(),
  })
  .strict();

const PublicRecordRevisionSchema = z
  .object({
    id: ShortIdSchema,
    revision: z.number().int().positive(),
    action: z.enum(["baseline", "created", "updated", "deleted", "restored", "finalized", "file.added", "file.replaced", "file.removed"]),
    recordVersion: z.number().int().positive(),
    data: z.record(ShortIdSchema, z.unknown()),
    files: z.array(PublicRevisionFileSchema),
    changedFieldIds: z.array(ShortIdSchema),
    deletedAt: z.string().datetime().nullable(),
    actorDisplayName: z.string().nullable(),
    actorAvatarHash: z.string().nullable(),
    createdAt: z.string().datetime(),
    fields: z.array(PublicFieldSchema),
  })
  .strict();

export const PublicRecordRevisionPageSchema = z
  .object({
    status: PublicDurableHistoryStatusSchema,
    items: z.array(PublicRecordRevisionSchema),
    nextCursor: ShortIdSchema.nullable(),
  })
  .strict();

export type PublicDurableHistoryStatus = z.infer<typeof PublicDurableHistoryStatusSchema>;
export type PublicRecordRevision = z.infer<typeof PublicRecordRevisionSchema>;
export type PublicRecordRevisionPage = z.infer<typeof PublicRecordRevisionPageSchema>;

export const toPublicDurableHistoryStatus = (status: DurableHistoryStatus): z.infer<typeof PublicDurableHistoryStatusSchema> =>
  status.enabled
    ? {
        enabled: true,
        status: status.status,
        activatedAt: status.activatedAt,
        baselineCompletedAt: status.baselineCompletedAt,
        baseline: status.baseline,
      }
    : { enabled: false };

export const toPublicRecordRevisions = async (
  revisions: readonly RecordRevision[],
): Promise<Array<z.infer<typeof PublicRecordRevisionSchema>>> => {
  const fieldIds = await projectPublicIds(
    "field",
    revisions.flatMap((revision) => [
      ...Object.keys(revision.data),
      ...Object.keys(revision.relations),
      ...revision.files.map((file) => file.fieldId),
      ...revision.changedFieldIds,
    ]),
  );
  const recordIds = await projectPublicIds(
    "record",
    revisions.flatMap((revision) => Object.values(revision.relations).flat()),
  );
  const fileIds = await projectPublicIds(
    "file",
    revisions.flatMap((revision) => revision.files.map((file) => file.id)),
  );
  const publicFieldsBySchema = new Map<string, Awaited<ReturnType<typeof toPublicFields>>>();
  for (const revision of revisions) {
    if (!publicFieldsBySchema.has(revision.schema.id)) {
      const fields = (await toPublicFields(revision.schema.fields)).map(({ numberSeries: _numberSeries, ...field }) => field);
      publicFieldsBySchema.set(revision.schema.id, fields);
    }
  }
  return revisions.map((revision) => {
    const data: Record<string, unknown> = {};
    for (const [fieldId, value] of Object.entries(revision.data)) {
      const publicFieldId = fieldIds.get(fieldId);
      if (publicFieldId) data[publicFieldId] = value;
    }
    for (const [fieldId, values] of Object.entries(revision.relations)) {
      const publicFieldId = fieldIds.get(fieldId);
      if (publicFieldId) data[publicFieldId] = values.flatMap((recordId) => (recordIds.get(recordId) ? [recordIds.get(recordId)!] : []));
    }
    return PublicRecordRevisionSchema.parse({
      id: revision.shortId,
      revision: revision.revisionNo,
      action: revision.action,
      recordVersion: revision.recordVersion,
      data,
      files: revision.files.flatMap((file) => {
        const id = fileIds.get(file.id);
        const fieldId = fieldIds.get(file.fieldId);
        return id && fieldId ? [{ ...file, id, fieldId }] : [];
      }),
      changedFieldIds: revision.changedFieldIds.flatMap((fieldId) => (fieldIds.get(fieldId) ? [fieldIds.get(fieldId)!] : [])),
      deletedAt: revision.deletedAt,
      actorDisplayName: revision.actorDisplayName,
      actorAvatarHash: revision.actorAvatarHash,
      createdAt: revision.createdAt,
      fields: publicFieldsBySchema.get(revision.schema.id) ?? [],
    });
  });
};

export const toPublicRecordRevisionPage = async (page: {
  status: DurableHistoryStatus;
  items: RecordRevision[];
  nextCursor: string | null;
}) =>
  PublicRecordRevisionPageSchema.parse({
    status: toPublicDurableHistoryStatus(page.status),
    items: await toPublicRecordRevisions(page.items),
    nextCursor: page.nextCursor,
  });
