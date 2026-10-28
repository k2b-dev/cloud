import type { TopicDeadLetter, TopicInventoryEntry } from "@k2b/sync";
import { type SQL, sql } from "bun";
import { lazySync } from "../_internal/process-sync";
import { getCapability, listCapabilities } from "../_internal/registry";
import type { AppEventEnvelope } from "../contracts/app-events";
import type { CapabilityRegistryEntry } from "../contracts/registry";
import { appEventTopic } from "../events/app-event-delivery";
import { createEventAcceptance } from "./app-events/accept";
import { createEventAdministration } from "./app-events/admin";
import { createDeclarationSync } from "./app-events/declarations";
import { createEventDelivery } from "./app-events/deliver";
import type { signAppEventInvocation } from "./identity/invocation-token";
import { logger } from "./logging";

export { APP_EVENT_DELIVERY_ATTEMPTS, APP_EVENT_DELIVERY_BACKOFF_MS } from "./app-events/deliver";

const log = logger("app-events:broker");
const topicInventory = lazySync((sync) => () => sync.listTopics({ idPrefix: "cloud:app-events" }));
type BrokerDependencies = {
  db?: SQL;
  registry?: () => Promise<CapabilityRegistryEntry[]>;
  getApp?: typeof getCapability;
  fetch?: typeof fetch;
  sign?: typeof signAppEventInvocation;
  deadLetters?: (after?: string) => Promise<TopicDeadLetter<AppEventEnvelope>[]>;
  streams?: () => AsyncIterable<Pick<TopicInventoryEntry, "id" | "firstSequence">>;
};
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 1000);

export const createAppEventBroker = (dependencies: BrokerDependencies = {}) => {
  const db = dependencies.db ?? sql;
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
  const worker = await appEventTopic().process(
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
      } catch (error) {
        if (event.attempt >= 8) {
          await appEventBroker.markSeen(event.sequence);
        }
        throw error;
      }
    },
  );
  let stopping = false;
  let active: Promise<void> | null = null;
  let tickCount = 0;
  const run = () => {
    if (stopping || active) return;
    active = (async () => {
      await appEventBroker.work();
      if (++tickCount % 60 === 0) {
        await appEventBroker.checkGap();
        await appEventBroker.retain();
      }
    })()
      .catch((error) => log.error("App event broker pass failed", { error: message(error) }))
      .finally(() => {
        active = null;
      });
  };
  const timer = setInterval(run, 1000);
  timer.unref();
  run();
  return async () => {
    stopping = true;
    clearInterval(timer);
    worker.stop();
    await worker.drain();
    await active;
  };
};
