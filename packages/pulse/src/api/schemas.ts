import { PermissionLevelSchema, PrincipalSchema, ServiceAccountCredentialSchema } from "@k2b/cloud/contracts";
import { z } from "zod";
import { METRIC_TYPES, SOURCE_KINDS } from "../contracts";
import { PULSE_EXTERNAL_INGEST_BATCH_LIMIT, PULSE_EXTERNAL_INGEST_COLLECTION_LIMIT } from "../ingest-limits";
import { MetricFiltersSchema } from "../metric-filters";
import { BaseStoreStatusSchema } from "../store/admin-schemas";
import {
  jsonBytes,
  PULSE_EXTERNAL_INGEST_MAX_BYTES,
  validateDimensions,
  validateEventAttributes,
  validateEventPayload,
  validateEventSensitive,
  validateResourceIdentity,
} from "../telemetry-contract";

export const PulseShortIdSchema = z.string().regex(/^[0-9A-Za-z]{6}$/);

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
  .strictObject({
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

const MetricSchema = z.strictObject({
  name: z.string().trim().min(1),
  value: z.number().finite(),
  ts: z.string().datetime().optional(),
  unit: z.string().trim().min(1).nullable().optional(),
  type: z.enum(METRIC_TYPES).optional(),
  sourceId: z.never().optional(),
  resource: ResourceSchema,
  dimensions: DimensionsSchema,
});

const EventSchema = z.strictObject({
  kind: z.string().trim().min(1),
  ts: z.string().datetime().optional(),
  value: z.number().finite().nullable().optional(),
  sourceId: z.never().optional(),
  actorId: z.string().trim().min(1).nullable().optional(),
  sessionId: z.string().trim().min(1).nullable().optional(),
  correlationId: z.string().trim().min(1).nullable().optional(),
  resource: ResourceSchema,
  dimensions: DimensionsSchema,
  attributes: EventAttributesSchema,
  sensitive: EventSensitiveSchema,
  payload: EventPayloadSchema,
});

const StateSchema = z.strictObject({
  key: z.string().trim().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  ts: z.string().datetime().optional(),
  sourceId: z.never().optional(),
  resource: ResourceSchema,
  dimensions: DimensionsSchema,
});

export const IngestBatchSchema = z
  .strictObject({
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
    confirmShorterRetention: z.boolean().optional(),
    expectedRetention: z
      .object({
        rawRetentionDays: z.number().int().min(1).max(3650),
        rollupRetentionDays: z.number().int().min(1).max(3650),
        sensitiveRetentionHours: z.number().int().min(1).max(8760),
      })
      .optional(),
  })
  .strict();

export const GrantBaseAccessSchema = z.object({
  principal: PrincipalSchema,
  permission: PermissionLevelSchema.exclude(["none"]),
});

export const UpdateBaseAccessSchema = z.object({
  permission: PermissionLevelSchema.exclude(["none"]),
});

export const SourceStatusSchema = z.object({
  newestDataAt: z.string().nullable(),
  throttled: z.boolean(),
  throttledAt: z.string().nullable(),
  refusedHistograms: z.array(z.object({ family: z.string(), reason: z.string() })).max(20),
  skippedSummaries: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
});

export const CreateSourceSchema = z.strictObject({
  kind: z.enum(SOURCE_KINDS),
  name: z.string().trim().min(1).max(120),
  endpointUrl: z.string().trim().min(1).max(2_000).nullable().optional(),
  bearerToken: z.string().trim().min(1).nullable().optional(),
  scrapeIntervalSeconds: z.number().int().min(60).max(86_400).multipleOf(60).nullable().optional(),
  metricFilters: MetricFiltersSchema.optional(),
});

export const CreateSourceApiKeySchema = z.object({
  name: z.string().trim().min(1).max(120),
  expiresAt: z.string().datetime().nullable().optional(),
  permission: z.literal("write").default("write"),
});

export const UpdateSourceSchema = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  endpointUrl: z.string().trim().min(1).max(2_000).nullable().optional(),
  bearerToken: z.string().trim().min(1).nullable().optional(),
  scrapeIntervalSeconds: z.number().int().min(60).max(86_400).multipleOf(60).nullable().optional(),
  metricFilters: MetricFiltersSchema.optional(),
});

export const MessageSchema = z.object({ message: z.string() });

export const BaseSchema = z.object({
  store: BaseStoreStatusSchema,
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
  metricFilters: MetricFiltersSchema,
  status: SourceStatusSchema,
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
