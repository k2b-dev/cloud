import { CapabilitySemanticLinkSchema } from "@k2b/cloud/contracts";
import { z } from "zod";
import { SourceStatusSchema } from "./api/schemas";
import { SOURCE_KINDS } from "./contracts";
import { MetricFiltersSchema } from "./metric-filters";
import { BaseStoreStatusSchema } from "./store/admin-schemas";

const TimestampSchema = z.string().datetime({ offset: true });
const CursorSchema = z.string().min(1).max(256).optional().describe("Opaque cursor returned by the previous page.");
const LimitSchema = z.number().int().min(1).max(100).default(25).describe("Maximum number of results to return.");
const QuerySchema = z.string().trim().max(500).optional().describe("Optional text search.");
const PageInputShape = { cursor: CursorSchema, limit: LimitSchema };
const ResourceLinksSchema = z.array(CapabilitySemanticLinkSchema).min(1).max(10).optional();
const ShortIdSchema = z.string().regex(/^[0-9A-Za-z]{6}$/);
const resourceRef = <Type extends string>(type: Type, id: z.ZodType = ShortIdSchema) => z.object({ type: z.literal(type), id }).strict();

export const BaseDataSchema = z
  .object({
    store: BaseStoreStatusSchema,
    id: ShortIdSchema,
    name: z.string().min(1).max(120),
    description: z.string().max(1_000).nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    links: ResourceLinksSchema,
  })
  .strict();
const BaseListItemDataSchema = BaseDataSchema.extend({ ref: resourceRef("pulse.base") }).strict();
export const BaseListDataSchema = z.array(BaseListItemDataSchema).max(100);
export const BaseListInputSchema = z.object({ query: QuerySchema, ...PageInputShape }).strict();
export const BaseReadInputSchema = z
  .object({ id: ShortIdSchema.describe("Pulse Base ID returned by Search/List Pulse Bases or a pulse.base ref.") })
  .strict();

export const SourceDataSchema = z
  .object({
    id: ShortIdSchema,
    baseId: ShortIdSchema,
    kind: z.enum(SOURCE_KINDS),
    name: z.string().min(1).max(120),
    enabled: z.boolean(),
    metricFilters: MetricFiltersSchema,
    status: SourceStatusSchema,
    lastSeenAt: TimestampSchema.nullable(),
    lastError: z.string().max(2_000).nullable(),
    lastErrorAt: TimestampSchema.nullable(),
    updatedAt: TimestampSchema,
    links: ResourceLinksSchema,
  })
  .strict();
const SourceListItemDataSchema = SourceDataSchema.extend({ ref: resourceRef("pulse.source") }).strict();
export const SourceListDataSchema = z.array(SourceListItemDataSchema).max(100);
export const SourceListInputSchema = z
  .object({
    baseId: ShortIdSchema.describe("Pulse Base ID returned by Search/List Pulse Bases or a pulse.base ref."),
    query: QuerySchema,
    ...PageInputShape,
  })
  .strict();
export const SourceReadInputSchema = z
  .object({ id: ShortIdSchema.describe("Pulse Source ID returned by List Pulse Sources or a pulse.source ref.") })
  .strict();
