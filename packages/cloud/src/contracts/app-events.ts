import { z } from "zod";
import { CapabilityAppIdSchema, CapabilityQualifiedIdSchema, CloudResourceRefSchema } from "./capabilities";

/** Maximum PostgreSQL jsonb-text size of the complete envelope, including separator spaces. */
export const APP_EVENT_MAX_BYTES = 4096;

export const AppEventEnvelopeSchema = z
  .object({
    id: z.uuid(),
    type: CapabilityQualifiedIdSchema,
    version: z.number().int().positive(),
    source: CapabilityAppIdSchema,
    time: z.iso.datetime({ offset: true }),
    subject: CloudResourceRefSchema,
    place: CloudResourceRefSchema.optional(),
    cause: z
      .object({ requestId: z.string().min(1).max(256) })
      .strict()
      .optional(),
    data: z.json(),
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
};

export type AppEventSubscriptionDefinition<Schema extends z.ZodType = z.ZodType> = {
  version: number;
  schema: Schema;
  run(envelope: AppEventEnvelope<z.output<Schema>>, context: AppEventDeliveryContext): unknown | Promise<unknown>;
};

export const appEventSubscriptionId = (subscriber: string, type: string, version: number): string =>
  `${CapabilityAppIdSchema.parse(subscriber)}:${CapabilityQualifiedIdSchema.parse(type)}@${z.number().int().positive().parse(version)}`;
