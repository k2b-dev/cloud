import { PermissionLevelSchema, PrincipalSchema, ServiceAccountCredentialSchema } from "@k2b/cloud/contracts";
import { z } from "zod";
import { AGGREGATIONS, EVENT_AGGREGATIONS, METRIC_TYPES, PANEL_VISUALS, SOURCE_KINDS } from "../contracts";
import { PULSE_EXTERNAL_INGEST_BATCH_LIMIT, PULSE_EXTERNAL_INGEST_COLLECTION_LIMIT } from "../ingest-limits";
import {
  jsonBytes,
  PULSE_EXTERNAL_INGEST_MAX_BYTES,
  PULSE_RESOURCE_KEY_MAX_LENGTH,
  validateDimensions,
  validateEventAttributes,
  validateEventPayload,
  validateEventSensitive,
  validateResourceIdentity,
} from "../telemetry-contract";

export const PulseShortIdSchema = z.string().regex(/^[0-9A-Za-z]{6}$/);

const durationToMs = (value: string): number | null => {
  const match = value.match(/^(\d+)(m|h|d)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const duration = match[2] === "m" ? amount * 60_000 : match[2] === "h" ? amount * 60 * 60_000 : amount * 24 * 60 * 60_000;
  return duration <= 90 * 24 * 60 * 60_000 ? duration : null;
};

const DurationSchema = z
  .string()
  .trim()
  .regex(/^\d+[mhd]$/)
  .refine((value) => durationToMs(value) !== null, "Duration must be 90d or shorter");

const DimensionValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const DimensionsSchema = z
  .record(z.string(), DimensionValueSchema)
  .superRefine((value, context) => {
    const message = validateDimensions(value);
    if (message) context.addIssue({ code: "custom", message });
  })
  .optional();

const EventAttributesSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, context) => {
    const message = validateEventAttributes(value);
    if (message) context.addIssue({ code: "custom", message });
  })
  .optional();

const EventPayloadSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, context) => {
    const message = validateEventPayload(value);
    if (message) context.addIssue({ code: "custom", message });
  })
  .optional();

const EventSensitiveSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, context) => {
    const message = validateEventSensitive(value);
    if (message) context.addIssue({ code: "custom", message });
  })
  .optional();

const ResourceSchema = z
  .object({
    type: z.string().trim().min(1).max(80),
    id: z.string().trim().min(1).max(500),
    label: z.string().trim().min(1).max(240).nullable().optional(),
  })
  .superRefine((resource, context) => {
    const message = validateResourceIdentity(resource.type, resource.id);
    if (message) context.addIssue({ code: "custom", message });
  })
  .nullable()
  .optional();

const MetricSchema = z.object({
  name: z.string().trim().min(1),
  value: z.number().finite(),
  ts: z.string().datetime().optional(),
  unit: z.string().trim().min(1).nullable().optional(),
  type: z.enum(METRIC_TYPES).optional(),
  sourceId: z.never().optional(),
  entityId: z.string().trim().min(1).nullable().optional(),
  entityType: z.string().trim().min(1).nullable().optional(),
  resource: ResourceSchema,
  dimensions: DimensionsSchema,
});

const EventSchema = z.object({
  kind: z.string().trim().min(1),
  ts: z.string().datetime().optional(),
  value: z.number().finite().nullable().optional(),
  sourceId: z.never().optional(),
  entityId: z.string().trim().min(1).nullable().optional(),
  entityType: z.string().trim().min(1).nullable().optional(),
  actorId: z.string().trim().min(1).nullable().optional(),
  sessionId: z.string().trim().min(1).nullable().optional(),
  correlationId: z.string().trim().min(1).nullable().optional(),
  resource: ResourceSchema,
  dimensions: DimensionsSchema,
  attributes: EventAttributesSchema,
  sensitive: EventSensitiveSchema,
  payload: EventPayloadSchema,
});

const StateSchema = z.object({
  key: z.string().trim().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  ts: z.string().datetime().optional(),
  sourceId: z.never().optional(),
  entityId: z.string().trim().min(1).nullable().optional(),
  entityType: z.string().trim().min(1).nullable().optional(),
  resource: ResourceSchema,
  dimensions: DimensionsSchema,
});

export const IngestBatchSchema = z
  .object({
    metrics: z.array(MetricSchema).max(PULSE_EXTERNAL_INGEST_COLLECTION_LIMIT).optional(),
    events: z.array(EventSchema).max(PULSE_EXTERNAL_INGEST_COLLECTION_LIMIT).optional(),
    states: z.array(StateSchema).max(PULSE_EXTERNAL_INGEST_COLLECTION_LIMIT).optional(),
  })
  .refine(
    (batch) =>
      (batch.metrics?.length ?? 0) + (batch.events?.length ?? 0) + (batch.states?.length ?? 0) <= PULSE_EXTERNAL_INGEST_BATCH_LIMIT,
    { message: `Ingest batch exceeds ${PULSE_EXTERNAL_INGEST_BATCH_LIMIT} total items` },
  )
  .superRefine((batch, context) => {
    const bytes = jsonBytes(batch);
    if (bytes === null) context.addIssue({ code: "custom", message: "Ingest batch must be valid JSON" });
    else if (bytes > PULSE_EXTERNAL_INGEST_MAX_BYTES)
      context.addIssue({ code: "custom", message: `Ingest batch cannot exceed ${PULSE_EXTERNAL_INGEST_MAX_BYTES} bytes` });
  });

export const CreateBaseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000).nullable().optional(),
});

export const UpdateBaseSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1_000).nullable().optional(),
    rawRetentionDays: z.number().int().min(1).max(3650).optional(),
    rollupRetentionDays: z.number().int().min(1).max(3650).optional(),
    sensitiveRetentionHours: z.number().int().min(1).max(8760).optional(),
  })
  .strict();

export const GrantBaseAccessSchema = z.object({
  principal: PrincipalSchema,
  permission: PermissionLevelSchema.exclude(["none"]),
});

export const UpdateBaseAccessSchema = z.object({
  permission: PermissionLevelSchema.exclude(["none"]),
});

export const CreateSourceSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  name: z.string().trim().min(1).max(120),
  endpointUrl: z.string().trim().min(1).max(2_000).nullable().optional(),
  bearerToken: z.string().trim().min(1).nullable().optional(),
  scrapeIntervalSeconds: z.number().int().min(10).max(86_400).nullable().optional(),
});

export const CreateSourceApiKeySchema = z.object({
  name: z.string().trim().min(1).max(120),
  expiresAt: z.string().datetime().nullable().optional(),
  permission: z.literal("write").default("write"),
});

export const UpdateSourceSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  endpointUrl: z.string().trim().min(1).max(2_000).nullable().optional(),
  bearerToken: z.string().trim().min(1).nullable().optional(),
  scrapeIntervalSeconds: z.number().int().min(10).max(86_400).nullable().optional(),
});

const DashboardMetricWidgetSchema = z.object({
  id: z.string().trim().min(1).max(80),
  kind: z.literal("metric"),
  title: z.string().trim().min(1).max(160),
  metric: z.string().trim().min(1).max(240),
  visual: z.enum(PANEL_VISUALS),
  aggregation: z.enum(AGGREGATIONS),
  bucket: DurationSchema,
  since: DurationSchema,
  sourceId: PulseShortIdSchema.nullable().optional(),
  entityId: z.string().nullable().optional(),
  entityType: z.string().nullable().optional(),
  dimensions: DimensionsSchema,
  queryText: z.string().trim().max(8_000).optional(),
  query: z
    .object({
      kind: z.literal("metric"),
      metric: z.string().trim().min(1).max(240),
      aggregation: z.enum(AGGREGATIONS),
      bucket: DurationSchema,
      since: DurationSchema,
      sourceId: PulseShortIdSchema.nullable().optional(),
      entityId: z.string().nullable().optional(),
      entityType: z.string().nullable().optional(),
      dimensions: DimensionsSchema,
    })
    .optional(),
  description: z.string().trim().max(500).nullable().optional(),
  conditions: z
    .array(
      z.object({
        level: z.enum(["warn", "critical"]),
        operator: z.enum([">", ">=", "<", "<=", "=", "!="]),
        value: z.union([z.string(), z.number(), z.boolean()]),
        message: z.string().trim().max(240).nullable().optional(),
      }),
    )
    .max(8)
    .optional(),
  span: z.number().int().min(1).max(12).optional(),
});

const DashboardEventQuerySchema = z.object({
  kind: z.literal("events"),
  event: z.string().trim().min(1).max(240).nullable(),
  since: DurationSchema,
  sourceId: PulseShortIdSchema.nullable().optional(),
  entityId: z.string().nullable().optional(),
  entityType: z.string().nullable().optional(),
  dimensions: DimensionsSchema,
  limit: z.number().int().min(1).max(1_000),
});

const DashboardStateQuerySchema = z.object({
  kind: z.literal("states"),
  state: z.string().trim().min(1).max(240).nullable(),
  since: DurationSchema.nullable().optional(),
  sourceId: PulseShortIdSchema.nullable().optional(),
  entityId: z.string().nullable().optional(),
  entityType: z.string().nullable().optional(),
  dimensions: DimensionsSchema,
  limit: z.number().int().min(1).max(1_000),
});

const DashboardEventsWidgetSchema = z.object({
  id: z.string().trim().min(1).max(80),
  kind: z.literal("events"),
  title: z.string().trim().min(1).max(160),
  visual: z.literal("table"),
  queryText: z.string().trim().max(8_000),
  query: DashboardEventQuerySchema,
  description: z.string().trim().max(500).nullable().optional(),
  conditions: DashboardMetricWidgetSchema.shape.conditions,
  span: z.number().int().min(1).max(12).optional(),
});

const DashboardStatesWidgetSchema = z.object({
  id: z.string().trim().min(1).max(80),
  kind: z.literal("states"),
  title: z.string().trim().min(1).max(160),
  visual: z.enum(["table", "stat"]),
  queryText: z.string().trim().max(8_000),
  query: DashboardStateQuerySchema,
  description: z.string().trim().max(500).nullable().optional(),
  conditions: DashboardMetricWidgetSchema.shape.conditions,
  span: z.number().int().min(1).max(12).optional(),
});

const MapFieldSelectorSchema = z
  .object({
    role: z.enum(["dimension", "attribute"]),
    path: z.string().trim().min(1).max(240),
  })
  .refine((selector) => selector.role === "dimension" || selector.path.split(".").every(Boolean), {
    message: "Attribute paths cannot contain empty segments",
    path: ["path"],
  });

const DashboardMapWidgetSchema = z.object({
  id: z.string().trim().min(1).max(80),
  kind: z.literal("map"),
  title: z.string().trim().min(1).max(160),
  queryText: z.string().trim().max(8_000),
  query: DashboardEventQuerySchema,
  latitude: MapFieldSelectorSchema,
  longitude: MapFieldSelectorSchema,
  label: MapFieldSelectorSchema.optional(),
  series: MapFieldSelectorSchema.optional(),
  size: z.enum(["count", "sum"]),
  description: z.string().trim().max(500).nullable().optional(),
  span: z.number().int().min(1).max(12).optional(),
});

const DashboardMarkdownWidgetSchema = z.object({
  id: z.string().trim().min(1).max(80),
  kind: z.literal("markdown"),
  title: z.string().trim().min(1).max(160).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  markdown: z.string().trim().max(8_000),
  span: z.number().int().min(1).max(12).optional(),
});

type DashboardWidgetInput =
  | z.infer<typeof DashboardMetricWidgetSchema>
  | z.infer<typeof DashboardEventsWidgetSchema>
  | z.infer<typeof DashboardStatesWidgetSchema>
  | z.infer<typeof DashboardMapWidgetSchema>
  | z.infer<typeof DashboardMarkdownWidgetSchema>
  | {
      id: string;
      kind: "card";
      title: string;
      description?: string | null;
      rows: DashboardRowInput[];
      span?: number;
    };
type DashboardRowInput = {
  id: string;
  kind: "row";
  height: "sm" | "md" | "lg";
  cells: DashboardWidgetInput[];
};

const DashboardWidgetSchema: z.ZodType<DashboardWidgetInput> = z.lazy(() =>
  z.union([
    DashboardMetricWidgetSchema,
    DashboardEventsWidgetSchema,
    DashboardStatesWidgetSchema,
    DashboardMapWidgetSchema,
    DashboardMarkdownWidgetSchema,
    z.object({
      id: z.string().trim().min(1).max(80),
      kind: z.literal("card"),
      title: z.string().trim().min(1).max(160),
      description: z.string().trim().max(500).nullable().optional(),
      rows: z.array(DashboardRowSchema).max(24),
      span: z.number().int().min(1).max(12).optional(),
    }),
  ]),
);

const DashboardRowSchema: z.ZodType<DashboardRowInput> = z.lazy(() =>
  z.object({
    id: z.string().trim().min(1).max(80),
    kind: z.literal("row"),
    height: z.enum(["sm", "md", "lg"]),
    cells: z.array(DashboardWidgetSchema).max(12),
  }),
);

type DashboardSectionInput = {
  id: string;
  kind: "section";
  title: string;
  description?: string | null;
  rows: z.infer<typeof DashboardRowSchema>[];
  sections?: DashboardSectionInput[];
};

const DashboardSectionSchema: z.ZodType<DashboardSectionInput> = z.lazy(() =>
  z.object({
    id: z.string().trim().min(1).max(80),
    kind: z.literal("section"),
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(500).nullable().optional(),
    rows: z.array(DashboardRowSchema).max(24),
    sections: z.array(DashboardSectionSchema).max(12).optional(),
  }),
);

const DashboardLayoutSchema = z.object({
  version: z.literal(1),
  description: z.string().trim().max(1_000).nullable().optional(),
  controls: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(80),
        kind: z.enum(["range", "source", "entity", "entity_type", "label", "text"]),
        variable: z.string().trim().min(1).max(80),
        label: z.string().trim().min(1).max(160),
        defaultValue: z.string().trim().max(240),
        options: z.array(z.string().trim().min(1).max(240)).max(100).optional(),
        entityType: z.string().trim().min(1).max(80).nullable().optional(),
      }),
    )
    .max(24)
    .optional(),
  sections: z.array(DashboardSectionSchema).max(24),
});

const DashboardConfigInputSchema = z
  .object({
    dsl: z.string().trim().min(1).max(40_000),
    refreshIntervalSeconds: z
      .union([z.literal(1), z.literal(5), z.literal(10), z.literal(60)])
      .nullable()
      .optional(),
  })
  .strict();

const DashboardConfigSchema = DashboardConfigInputSchema.extend({
  layout: DashboardLayoutSchema.nullable(),
});

export const CreateDashboardSchema = z.object({
  name: z.string().trim().min(1).max(120),
  config: DashboardConfigInputSchema,
});

export const UpdateDashboardSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  config: DashboardConfigInputSchema.optional(),
});

export const MetricQuerySchema = z.object({
  baseId: PulseShortIdSchema,
  metric: z.string().trim().min(1),
  aggregation: z.enum(AGGREGATIONS),
  bucket: DurationSchema,
  since: DurationSchema,
  sourceId: PulseShortIdSchema.nullable().optional(),
  entityId: z.string().nullable().optional(),
  entityType: z.string().nullable().optional(),
  dimensions: DimensionsSchema,
  reduce: z.enum(["sum", "avg", "min", "max"]).nullable().optional(),
  groupBy: z.string().trim().min(1).max(80).nullable().optional(),
});

const CompiledMetricQuerySchema = MetricQuerySchema.extend({ kind: z.literal("metric") });

const EventQuerySchema = z.object({
  kind: z.literal("events"),
  baseId: PulseShortIdSchema,
  event: z.string().nullable(),
  since: DurationSchema,
  sourceId: PulseShortIdSchema.nullable().optional(),
  entityId: z.string().nullable().optional(),
  entityType: z.string().nullable().optional(),
  dimensions: DimensionsSchema,
  aggregation: z.enum(EVENT_AGGREGATIONS).optional(),
  bucket: DurationSchema.nullable().optional(),
  groupBy: z.array(z.string().trim().min(1).max(80)).max(4).optional(),
  limit: z.number().int().positive().max(1_000),
});

const StateQuerySchema = z.object({
  kind: z.literal("states"),
  baseId: PulseShortIdSchema,
  state: z.string().nullable(),
  since: DurationSchema.nullable().optional(),
  sourceId: PulseShortIdSchema.nullable().optional(),
  entityId: z.string().nullable().optional(),
  entityType: z.string().nullable().optional(),
  dimensions: DimensionsSchema,
  limit: z.number().int().positive().max(1_000),
});

const ExplorerQuerySchema = z.discriminatedUnion("kind", [CompiledMetricQuerySchema, EventQuerySchema, StateQuerySchema]);

export const QueryTextSchema = z.object({
  baseId: PulseShortIdSchema,
  query: z.string().trim().min(1).max(2_000),
});

export const EventMapQueryTextSchema = QueryTextSchema.extend({
  latitude: MapFieldSelectorSchema,
  longitude: MapFieldSelectorSchema,
  label: MapFieldSelectorSchema.optional(),
  series: MapFieldSelectorSchema.optional(),
  size: z.enum(["count", "sum"]),
});

export const CompileTextQuerySchema = QueryTextSchema;

export const DashboardDslCompileSchema = z.object({
  baseId: PulseShortIdSchema,
  text: z.string().trim().min(1).max(40_000),
});

export const CreateSavedQuerySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000).nullable().optional(),
  query: z.string().trim().min(1).max(2_000),
});

export const MetricSeriesQuerySchema = z.object({
  metric: z.string().trim().min(1).max(240),
  sourceId: PulseShortIdSchema.optional(),
  entityId: z.string().trim().min(1).max(500).optional(),
  entityType: z.string().trim().min(1).max(120).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

export const ActivitySearchQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  sourceId: PulseShortIdSchema.optional(),
  entityId: z.string().trim().min(1).max(500).optional(),
  entityType: z.string().trim().min(1).max(120).optional(),
  kind: z.string().trim().min(1).max(240).optional(),
  key: z.string().trim().min(1).max(240).optional(),
});

export const MetricsQuerySchema = ActivitySearchQuerySchema.extend({
  type: z.enum(METRIC_TYPES).optional(),
});

export const ResourceListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  ref: z.string().trim().min(1).max(PULSE_RESOURCE_KEY_MAX_LENGTH).optional(),
  type: z.string().trim().min(1).max(120).optional(),
  sourceId: PulseShortIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

export const SignalFieldQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  sourceId: PulseShortIdSchema.optional(),
  scope: z.enum(["metric", "event", "state"]).optional(),
  role: z.enum(["dimension", "attribute", "sensitive"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

export const ResourceMetricQuerySchema = z.object({
  resourceKey: z.string().trim().min(1).max(PULSE_RESOURCE_KEY_MAX_LENGTH),
  q: z.string().trim().max(200).optional(),
  sourceId: PulseShortIdSchema.optional(),
  type: z.enum(METRIC_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

export const ResourceEventQuerySchema = z.object({
  resourceKey: z.string().trim().min(1).max(PULSE_RESOURCE_KEY_MAX_LENGTH),
  q: z.string().trim().max(200).optional(),
  sourceId: PulseShortIdSchema.optional(),
  kind: z.string().trim().min(1).max(240).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

export const ResourceStateQuerySchema = z.object({
  resourceKey: z.string().trim().min(1).max(PULSE_RESOURCE_KEY_MAX_LENGTH),
  q: z.string().trim().max(200).optional(),
  sourceId: PulseShortIdSchema.optional(),
  key: z.string().trim().min(1).max(240).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

export const MessageSchema = z.object({ message: z.string() });

export const BaseSchema = z.object({
  id: PulseShortIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  rawRetentionDays: z.number(),
  rollupRetentionDays: z.number(),
  sensitiveRetentionHours: z.number(),
  createdBy: z.string().nullable(),
  deletionStartedAt: z.string().nullable(),
  deletionFailedAt: z.string().nullable(),
  deletionError: z.string().nullable(),
  dataClearStartedAt: z.string().nullable(),
  dataClearCompletedAt: z.string().nullable(),
  dataClearFailedAt: z.string().nullable(),
  dataClearError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const SourceSchema = z.object({
  id: PulseShortIdSchema,
  baseId: PulseShortIdSchema,
  kind: z.enum(SOURCE_KINDS),
  name: z.string(),
  enabled: z.boolean(),
  endpointUrl: z.string().nullable(),
  bearerTokenConfigured: z.boolean(),
  scrapeIntervalSeconds: z.number().nullable(),
  lastSeenAt: z.string().nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const SourceScrapeSchema = z.object({
  id: z.string(),
  sourceId: PulseShortIdSchema,
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number(),
  success: z.boolean(),
  metrics: z.number(),
  events: z.number(),
  states: z.number(),
  errorMessage: z.string().nullable(),
});

export const SourceApiKeySchema = ServiceAccountCredentialSchema.extend({
  permission: PermissionLevelSchema,
});

export const DashboardSchema = z.object({
  id: PulseShortIdSchema,
  baseId: PulseShortIdSchema,
  name: z.string(),
  config: DashboardConfigSchema,
  publicEnabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const StreamPointSchema = z.object({
  bucket: z.string(),
  value: z.number().nullable(),
  group: z.record(z.string(), z.string()).optional(),
});

const MapPointSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  label: z.string().max(240).optional(),
  size: z.number().nonnegative(),
});

const MapSeriesSchema = z.object({
  label: z.string().max(240).optional(),
  data: z.array(MapPointSchema).max(1_000),
});

const PublicDashboardSchema = z.object({
  id: PulseShortIdSchema,
  name: z.string(),
  config: z.object({
    layout: z.unknown().nullable(),
    refreshIntervalSeconds: z.number().nullable().optional(),
  }),
});

const PublicRecordedEventSchema = z.object({
  id: z.string(),
  kind: z.string(),
  ts: z.string(),
  value: z.number().nullable(),
  entityId: z.string().nullable(),
  entityType: z.string().nullable(),
});

const PublicCurrentStateSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  entityId: z.string(),
  entityType: z.string().nullable(),
  updatedAt: z.string(),
});

export const SavedQuerySchema = z.object({
  id: PulseShortIdSchema,
  baseId: PulseShortIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  query: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const DashboardDslDiagnosticSchema = z.object({
  severity: z.literal("error"),
  message: z.string(),
  line: z.number(),
  column: z.number(),
});

export const DashboardDslCompileResultSchema = z.object({
  ok: z.boolean(),
  diagnostics: z.array(DashboardDslDiagnosticSchema),
  config: DashboardConfigSchema.nullable(),
});

export const DashboardSnapshotSchema = z.object({
  dashboard: PublicDashboardSchema,
  points: z.record(z.string(), z.array(StreamPointSchema)),
  events: z.record(z.string(), z.array(PublicRecordedEventSchema)),
  states: z.record(z.string(), z.array(PublicCurrentStateSchema)),
  maps: z.record(z.string(), z.array(MapSeriesSchema)),
});

export const EventMapResultSchema = z.array(MapSeriesSchema).max(1_000);

export const MetricSeriesSchema = z.object({
  id: z.string(),
  metric: z.string(),
  sourceId: PulseShortIdSchema.nullable(),
  entityId: z.string().nullable(),
  entityType: z.string().nullable(),
  dimensions: z.record(z.string(), z.string()),
  lastSeenAt: z.string().nullable(),
  latestValue: z.number().nullable(),
  latestSampleAt: z.string().nullable(),
});

export const ResourceSummarySchema = z.object({
  key: z.string(),
  id: z.string(),
  label: z.string(),
  type: z.string().nullable(),
  sourceIds: z.array(PulseShortIdSchema),
  metricSeriesCount: z.number(),
  metricCount: z.number(),
  eventCount: z.number(),
  stateCount: z.number(),
  lastSeenAt: z.string().nullable(),
  dimensions: z.record(z.string(), z.string()),
});

export const ResourceMetricSchema = z.object({
  seriesId: z.string(),
  resourceKey: z.string(),
  resourceId: z.string(),
  resourceType: z.string().nullable(),
  metric: z.string(),
  type: z.enum(METRIC_TYPES),
  unit: z.string().nullable(),
  sourceId: PulseShortIdSchema.nullable(),
  dimensions: z.record(z.string(), z.string()),
  lastSeenAt: z.string().nullable(),
  latestValue: z.number().nullable(),
  latestSampleAt: z.string().nullable(),
});

export const RecordedEventSchema = z.object({
  id: z.string(),
  kind: z.string(),
  ts: z.string(),
  value: z.number().nullable(),
  sourceId: PulseShortIdSchema.nullable(),
  entityId: z.string().nullable(),
  entityType: z.string().nullable(),
  dimensions: z.record(z.string(), z.string()),
  attributes: z.record(z.string(), z.unknown()),
  payload: z.record(z.string(), z.unknown()),
  recordedAt: z.string(),
});

export const CurrentStateSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  sourceId: PulseShortIdSchema.nullable(),
  entityId: z.string(),
  entityType: z.string().nullable(),
  dimensions: z.record(z.string(), z.string()),
  updatedAt: z.string(),
});

export const SignalFieldSchema = z.object({
  sourceId: PulseShortIdSchema,
  scope: z.enum(["metric", "event", "state"]),
  signalName: z.string(),
  role: z.enum(["dimension", "attribute", "sensitive"]),
  key: z.string(),
  valueType: z.enum(["null", "string", "number", "boolean", "object", "array", "mixed"]),
  observedCount: z.number(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
});

export const InventorySchema = z.object({
  resources: z.array(ResourceSummarySchema),
  metrics: z.array(ResourceMetricSchema),
  events: z.array(RecordedEventSchema),
  states: z.array(CurrentStateSchema),
  fields: z.array(SignalFieldSchema),
});

export const MetricQueryResultSchema = z.object({
  compiled: ExplorerQuerySchema,
  points: z.array(StreamPointSchema),
  events: z.array(RecordedEventSchema),
  states: z.array(CurrentStateSchema),
});

export const QueryCompileResultSchema = z.object({
  ok: z.boolean(),
  diagnostics: z.array(z.object({ severity: z.enum(["error", "info"]), message: z.string() })),
  compiled: ExplorerQuerySchema.nullable(),
});
