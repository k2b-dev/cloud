import { z } from "zod";
import { CapabilityAppIdSchema, CapabilityQualifiedIdSchema, CloudResourceRefSchema } from "./capabilities";

/** Maximum PostgreSQL jsonb-text size of the complete envelope, including separator spaces. */
export const APP_EVENT_MAX_BYTES = 4096;

export const AppEventEnvelopeSchema = z
  .object({
    id: z.uuid().describe("Stable event UUID."),
    type: CapabilityQualifiedIdSchema.describe("Qualified declared event name."),
    version: z.number().int().positive().describe("Declared event schema version."),
    source: CapabilityAppIdSchema.describe("Publishing application ID."),
    time: z.iso.datetime({ offset: true }).describe("Time the event occurred."),
    subject: CloudResourceRefSchema.describe("Reference to the event subject."),
    place: CloudResourceRefSchema.optional().describe("Resource that owns the event handler."),
    cause: z
      .object({ requestId: z.string().min(1).max(256).describe("Originating request identity.") })
      .strict()
      .optional()
      .describe("Optional originating request metadata."),
    data: z.json().describe("Payload matching the declared event schema."),
  })
  .strict();

export type AppEventEnvelope<Data = unknown> = Omit<z.infer<typeof AppEventEnvelopeSchema>, "data"> & { data: Data };

/** Delivery runs as the subscribing service, without a user's request authority. */
export type AppEventDeliveryContext = {
  subscriptionId: string;
  eventId: string;
  attempt: number;
  signal: AbortSignal;
};

export type AppEventDefinition<Schema extends z.ZodType = z.ZodType> = {
  version: number;
  title: string;
  description: string;
  subject: string;
  place?: string;
  schema: Schema;
  automation?: false;
  /** Permission-aware query ({ id: subject.id } -> envelope) for one immutable occurrence per subject. */
  catchup?: string;
};

export type AppEventSubscriptionDefinition<Schema extends z.ZodType = z.ZodType> = {
  version: number;
  schema: Schema;
  run(envelope: AppEventEnvelope<z.output<Schema>>, context: AppEventDeliveryContext): unknown | Promise<unknown>;
};

export const appEventSubscriptionId = (subscriber: string, type: string, version: number): string =>
  `${CapabilityAppIdSchema.parse(subscriber)}:${CapabilityQualifiedIdSchema.parse(type)}@${z.number().int().positive().parse(version)}`;
