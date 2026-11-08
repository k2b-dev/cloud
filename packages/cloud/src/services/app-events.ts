import type { TopicDeadLetter, TopicInventoryEntry } from "@k2b/sync";
import type { SQL } from "bun";
import { lazySync } from "../_internal/process-sync";
import { getCapability, listCapabilities, watchAppRegistry } from "../_internal/registry";
import { notifyWork, subscribeWorkWake } from "../_internal/work-wake";
import type { AppEventEnvelope } from "../contracts/app-events";
import type { CapabilityRegistryEntry } from "../contracts/registry";
import { appEventTopic } from "../events/app-event-delivery";
import { sql } from "../runtime/clients";
import { createEventAcceptance } from "./app-events/accept";
import { createEventAdministration } from "./app-events/admin";
import { createDeclarationSync } from "./app-events/declarations";
import { createEventDelivery } from "./app-events/deliver";
import type { authorizeResourceEvent, resourceEventConsumer } from "./app-events/resources";
import { startEventDispatcher } from "./app-events/runtime";
import type { signAppEventInvocation } from "./identity/invocation-token";
import { logger } from "./logging";
import { superviseRuntimeTask } from "./runtime-lifecycle";

export { APP_EVENT_DELIVERY_ATTEMPTS, APP_EVENT_DELIVERY_BACKOFF_MS } from "./app-events/deliver";
export type { ResourceEventBinding, ResourceEventConsumer } from "./app-events/resources";
export {
  authorizeResourceEvent,
  cancelResourceEventSubscriptions,
  registerResourceEventConsumer,
  replayResourceEventDelivery,
  subscribeResourceEvent,
} from "./app-events/resources";

const log = logger("app-events:broker");
const topicInventory = lazySync((sync) => () => sync.listTopics({ idPrefix: "cloud:app-events" }));
type BrokerDependencies = {
  db?: SQL;
  registry?: () => Promise<CapabilityRegistryEntry[]>;
  getApp?: typeof getCapability;
  fetch?: typeof fetch;
  sign?: typeof signAppEventInvocation;
  authorizeResource?: typeof authorizeResourceEvent;
  resourceConsumer?: typeof resourceEventConsumer;
  deadLetters?: (after?: string) => Promise<TopicDeadLetter<AppEventEnvelope>[]>;
  streams?: () => AsyncIterable<Pick<TopicInventoryEntry, "id" | "firstSequence">>;
};
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 1000);

export const createAppEventBroker = (dependencies: BrokerDependencies = {}) => {
  const db = () => dependencies.db ?? sql;
  const registry = dependencies.registry ?? listCapabilities;
  const declarations = createDeclarationSync(db, registry);
  const admin = createEventAdministration(db, {
    registry,
    deadLetters: dependencies.deadLetters ?? ((after) => appEventTopic().deadLetters.list({ limit: 100, after })),
    streams: dependencies.streams ?? (() => topicInventory()()),
  });
  const acceptance = createEventAcceptance(db, declarations.reconcileSubscriptions);
  const delivery = createEventDelivery(db, dependencies.getApp ?? getCapability, declarations.reconcileSubscriptions, dependencies);
  return { ...declarations, ...acceptance, ...delivery, ...admin };
};

export const appEventBroker = createAppEventBroker();
export const startAppEventBroker = async (): Promise<() => Promise<void>> => {
  const topic = appEventTopic();
  const dispatcher = startEventDispatcher(appEventBroker, (error) => log.error("App event broker pass failed", { error: message(error) }));
  let unsubscribe = () => {};
  try {
    unsubscribe = subscribeWorkWake("app-events:delivery", dispatcher.wake);
  } catch (error) {
    log.warn("App event wake subscription failed; safety scan will recover", { error: message(error) });
  }
  const controller = new AbortController();
  const registryReader = superviseRuntimeTask({
    name: "App event declarations",
    signal: controller.signal,
    run: (signal) =>
      watchAppRegistry({
        signal,
        onChange: async () => {
          await appEventBroker.reconcileSubscriptions();
          dispatcher.wake();
        },
      }),
    onError: ({ error }) => log.error("App event declaration sync failed", { error: message(error) }),
  });
  const worker = await topic
    .process(
      {
        consumer: "core-app-events-v1",
        start: "earliest",
        concurrency: 1,
        recoverDeadLetters: true,
        delivery: { maxAttempts: 8, backoffMs: [1000, 5000, 30000, 120000, 600000, 1800000, 3600000], maxInFlight: 1 },
      },
      async (event) => {
        try {
          await appEventBroker.accept(event.data, event.sequence, event.attempt);
          // accept() commits the durable deliveries before the dispatcher can claim them.
          dispatcher.wake();
          notifyWork("app-events:delivery");
        } catch (error) {
          if (event.attempt >= 8) {
            await appEventBroker.markSeen(event.sequence);
          }
          throw error;
        }
      },
    )
    .catch(async (error: unknown) => {
      unsubscribe();
      controller.abort();
      await registryReader;
      await dispatcher.stop();
      throw error;
    });
  return async () => {
    unsubscribe();
    controller.abort();
    worker.stop();
    try {
      await worker.drain();
    } finally {
      try {
        await registryReader;
      } finally {
        await dispatcher.stop();
      }
    }
  };
};
