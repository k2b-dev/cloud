import { z } from "zod";
import { ShortIdSchema } from "../contracts";
import type { ReferencedByPage } from "../service/referenced-by";

const PublicReferencedByItemSchema = z
  .object({
    sourceTableId: ShortIdSchema,
    sourceTableName: z.string(),
    sourceRecordId: ShortIdSchema,
    sourceRecordLabel: z.string(),
    relationFieldId: ShortIdSchema,
    relationFieldName: z.string(),
  })
  .strict();

export const PublicReferencedByPageSchema = z
  .object({
    items: z.array(PublicReferencedByItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

type PublicReferencedByPage = z.infer<typeof PublicReferencedByPageSchema>;

export const toPublicReferencedByPage = (page: ReferencedByPage): PublicReferencedByPage =>
  PublicReferencedByPageSchema.parse({
    items: page.items.map((item) => ({
      sourceTableId: item.sourceTableShortId,
      sourceTableName: item.sourceTableName,
      sourceRecordId: item.sourceRecordShortId,
      sourceRecordLabel: item.sourceRecordLabel,
      relationFieldId: item.relationFieldShortId,
      relationFieldName: item.relationFieldName,
    })),
    nextCursor: page.nextCursor,
  });
