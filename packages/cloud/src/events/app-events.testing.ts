import {
  type AppEventDeliveryContext,
  type AppEventEnvelope,
  AppEventEnvelopeSchema,
  appEventSubscriptionId,
} from "../contracts/app-events";
import type { CapabilityDefinitions } from "../contracts/capabilities";
import {
  type AppEventPublishInput,
  appEventBinding,
  bindAppEvents,
  buildAppEventEnvelope,
  deliverAppEvent as deliverCompiledAppEvent,
} from "./app-events";

type EventKey<T extends CapabilityDefinitions> = Extract<keyof NonNullable<T["events"]>, string>;

/** Producer fixture, validated exactly like publish. A standalone test may supply its app ID explicitly. */
export const appEventFixture = <const T extends CapabilityDefinitions, Key extends EventKey<T>>(
  capabilities: T,
  localName: Key,
  input: AppEventPublishInput<T, Key>,
  options: { id?: string; time?: string; appId?: string } = {},
): AppEventEnvelope => {
  if (options.appId !== undefined) bindAppEvents(options.appId, capabilities);
  return buildAppEventEnvelope(capabilities, localName, input, {
    id: options.id ?? "00000000-0000-4000-8000-000000000001",
    time: options.time ?? "2026-01-01T00:00:00.000Z",
  });
};

/** Exercises the framework's real delivery validation and the declared subscriber. */
export const deliverAppEvent = async (
  capabilities: CapabilityDefinitions,
  eventType: string,
  envelope: unknown,
  context: Partial<AppEventDeliveryContext> & { appId?: string } = {},
): Promise<void> => {
  if (context.appId !== undefined) bindAppEvents(context.appId, capabilities);
  const { appId, compiled } = appEventBinding(capabilities);
  const parsed = AppEventEnvelopeSchema.parse(envelope);
  if (parsed.type !== eventType) throw new Error("App event type does not match the tested subscription");
  const subscriptionId = appEventSubscriptionId(appId, eventType, parsed.version);
  await deliverCompiledAppEvent({
    compiled,
    subscriptionId,
    envelope,
    context: {
      subscriptionId: context.subscriptionId ?? subscriptionId,
      eventId: context.eventId ?? parsed.id,
      attempt: context.attempt ?? 1,
      signal: context.signal ?? new AbortController().signal,
    },
  });
};

/** Explicit app ID for standalone declarations that have no defineApp binding. */
export const createAppEventTestHarness = (appId: string, capabilities: CapabilityDefinitions) => {
  bindAppEvents(appId, capabilities);
  return {
    manifest: appEventBinding(capabilities).compiled.manifest,
    deliver: (envelope: AppEventEnvelope, context: Partial<AppEventDeliveryContext> = {}): Promise<void> =>
      deliverAppEvent(capabilities, envelope.type, envelope, context),
  };
};
