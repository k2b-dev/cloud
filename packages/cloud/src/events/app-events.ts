import { isDeepStrictEqual } from "node:util";
import type { SQL } from "bun";
import { z } from "zod";
import { assertAppEventSize } from "../_internal/app-event-schemas";
import { type CompiledCapabilities, compileCapabilities } from "../_internal/capabilities";
import { capabilityHash } from "../_internal/capability-schemas";
import {
  type AppEventDeliveryContext,
  type AppEventEnvelope,
  AppEventEnvelopeSchema,
  appEventSubscriptionId,
} from "../contracts/app-events";
import { CapabilityAppIdSchema, type CapabilityDefinitions } from "../contracts/capabilities";
import { registerAppEventPublisher, wakeAppEventDelivery } from "./app-event-delivery";

const bindings = new WeakMap<CapabilityDefinitions, { appId: string; compiled: CompiledCapabilities }>();

/** Framework hook: bind the exact declaration object when defineApp assigns its app ID. */
export const bindAppEvents = (appId: string, definitions: CapabilityDefinitions, compiledInput?: CompiledCapabilities): void => {
  CapabilityAppIdSchema.parse(appId);
  const prior = bindings.get(definitions);
  if (prior && prior.appId !== appId) throw new Error(`Capabilities are already bound to ${prior.appId}`);
  const compiled = compiledInput ?? prior?.compiled ?? compileCapabilities(appId, definitions);
  bindings.set(definitions, { appId, compiled });
  if (compiled.events.size > 0) registerAppEventPublisher(appId);
};

export const appEventBinding = (definitions: CapabilityDefinitions) => {
  const binding = bindings.get(definitions);
  if (!binding)
    throw new Error("Bind event capabilities with defineApp before publishing or testing; a test harness accepts an explicit appId");
  return binding;
};

type EventDeclarations<T extends CapabilityDefinitions> = NonNullable<T["events"]>;
export type AppEventPublishInput<T extends CapabilityDefinitions, Key extends keyof EventDeclarations<T>> = {
  subject: string;
  data: z.input<EventDeclarations<T>[Key]["schema"]>;
  requestId?: string;
} & (EventDeclarations<T>[Key] extends { place: string } ? { place: string } : { place?: never });

/** The same declaration, JSON and byte validation for publishers and producer fixtures. */
export const buildAppEventEnvelope = <const T extends CapabilityDefinitions, Key extends Extract<keyof EventDeclarations<T>, string>>(
  definitions: T,
  localId: Key,
  input: AppEventPublishInput<T, Key>,
  identity: { id: string; time: string },
): AppEventEnvelope => {
  const binding = appEventBinding(definitions);
  const event = binding.compiled.events.get(localId);
  if (!event) throw new Error(`Unknown app event ${localId}`);
  if ((event.manifest.place !== undefined) !== (input.place !== undefined)) {
    throw new Error(`Event ${localId} place does not match its declaration`);
  }
  const data = z.json().parse(input.data);
  if (!isDeepStrictEqual(input.data, JSON.parse(JSON.stringify(data)))) {
    throw new Error("Event data must round-trip through JSON without normalization");
  }
  const parsed = event.definition.schema.parse(data);
  if (capabilityHash(parsed) !== capabilityHash(data)) throw new Error("Event schema must preserve the original JSON data");
  const envelope = AppEventEnvelopeSchema.parse({
    ...identity,
    type: `${binding.appId}.${localId}`,
    version: event.manifest.version,
    source: binding.appId,
    subject: { type: `${binding.appId}.${event.manifest.subject}`, id: input.subject },
    ...(event.manifest.place !== undefined ? { place: { type: `${binding.appId}.${event.manifest.place}`, id: input.place } } : {}),
    ...(input.requestId !== undefined ? { cause: { requestId: input.requestId } } : {}),
    data,
  });
  assertAppEventSize(envelope);
  return envelope;
};

/** Writes in the domain transaction; wake only after commit. Delivery is at least once. */
export const appEvents = <const T extends CapabilityDefinitions>(definitions: T) => ({
  publish: async <Key extends Extract<keyof EventDeclarations<T>, string>>(
    tx: SQL,
    localId: Key,
    input: AppEventPublishInput<T, Key>,
  ): Promise<AppEventEnvelope> => {
    const envelope = buildAppEventEnvelope(definitions, localId, input, { id: crypto.randomUUID(), time: new Date().toISOString() });
    // A full valid resource ref can exceed the existing outbox's 600-character key bound.
    const orderingKey = capabilityHash(envelope.subject);
    await tx`SELECT events.enqueue(${envelope.id}::uuid, ${envelope.source}, 'event', ${orderingKey}, ${JSON.stringify(envelope)}::text::jsonb)`;
    return envelope;
  },
  wake: (): void => {
    const binding = bindings.get(definitions);
    if (binding) wakeAppEventDelivery(binding.appId);
  },
});

/** Shared by the framework route and subscription tests; validates before executing application code. */
export const deliverAppEvent = async (params: {
  compiled: CompiledCapabilities;
  subscriptionId: string;
  envelope: unknown;
  context: AppEventDeliveryContext;
}): Promise<void> => {
  const envelope = AppEventEnvelopeSchema.parse(params.envelope);
  assertAppEventSize(envelope);
  if (
    !envelope.type.startsWith(`${envelope.source}.`) ||
    !envelope.subject.type.startsWith(`${envelope.source}.`) ||
    (envelope.place && !envelope.place.type.startsWith(`${envelope.source}.`))
  )
    throw new Error("App event source does not match its namespaced types");
  if (envelope.place) throw new Error("resource_events_unsupported");
  const subscription = params.compiled.subscribes.get(envelope.type);
  if (!subscription || subscription.manifest.version !== envelope.version) {
    throw new Error("App event subscription not found for type and version");
  }
  if (params.subscriptionId !== appEventSubscriptionId(params.compiled.manifest.appId, envelope.type, envelope.version)) {
    throw new Error("App event subscription ID mismatch");
  }
  if (
    params.context.subscriptionId !== params.subscriptionId ||
    params.context.eventId !== envelope.id ||
    !Number.isSafeInteger(params.context.attempt) ||
    params.context.attempt < 1
  )
    throw new Error("App event delivery context mismatch");
  params.context.signal.throwIfAborted();
  const data = subscription.definition.schema.parse(envelope.data);
  await subscription.definition.run({ ...envelope, data }, params.context);
};
