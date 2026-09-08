import { z } from "zod";
import { ShortIdSchema, TableMutationPolicySchema } from "../contracts";
import { projectPublicIds } from "../service/public-resources";
import type { TableAdminOverviewPage } from "../service/table-admin-overview";

export const PublicTableAdminOverviewQuerySchema = z
  .object({
    q: z.string().trim().max(100).optional().default(""),
    kind: z.enum(["all", "stored", "combined"]).optional().default("all"),
    history: z.enum(["all", "off", "preparing", "active"]).optional().default("all"),
    finalization: z.enum(["all", "off", "direct", "fourEyes"]).optional().default("all"),
    page: z.coerce.number().int().min(1).optional().default(1),
    perPage: z.coerce.number().int().min(1).max(100).optional().default(25),
  })
  .strict();

const PublicTableAdminOverviewItemSchema = z.object({
  id: ShortIdSchema,
  name: z.string(),
  kind: z.enum(["stored", "combined"]),
  fieldCount: z.number().int().nonnegative(),
  indexedFieldCount: z.number().int().nonnegative(),
  uniqueFieldCount: z.number().int().nonnegative(),
  durableHistory: z.enum(["off", "preparing", "active"]),
  finalizationMode: z.enum(["off", "direct", "fourEyes"]),
  approverGroupId: z.string().uuid().nullable(),
  approverGroupName: z.string().nullable(),
  mutationPolicy: TableMutationPolicySchema,
  updatedAt: z.string().datetime({ offset: true }),
});
export type PublicTableAdminOverviewItem = z.infer<typeof PublicTableAdminOverviewItemSchema>;

export const PublicTableAdminOverviewPageSchema = z.object({
  items: z.array(PublicTableAdminOverviewItemSchema),
  page: z.number().int().positive(),
  perPage: z.number().int().positive(),
  total: z.number().int().nonnegative(),
});
export type PublicTableAdminOverviewPage = z.infer<typeof PublicTableAdminOverviewPageSchema>;

export const toPublicTableAdminOverview = async (page: TableAdminOverviewPage): Promise<PublicTableAdminOverviewPage> => {
  const ids = await projectPublicIds(
    "table",
    page.items.map((item) => item.id),
  );
  return PublicTableAdminOverviewPageSchema.parse({
    ...page,
    items: page.items.map((item) => {
      const id = ids.get(item.id);
      if (!id) throw new Error(`Missing public ID for table ${item.id}`);
      return { ...item, id };
    }),
  });
};
