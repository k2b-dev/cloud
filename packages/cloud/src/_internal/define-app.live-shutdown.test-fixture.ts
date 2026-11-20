import { spyOn } from "bun:test";
import type { Sync, Topic } from "@k2b/sync";
import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import { z } from "zod";
import { appAccess } from "../contracts/app-access";
import * as accessEvents from "../events/app-access";
import { defineLive } from "../events/live";
import * as delivery from "../events/live-delivery";
import type { LiveEnvelope } from "../events/live-engine";
import { stubConnections } from "../runtime/connections.test-fixture";
import { guardAppAccessSocket } from "../server/middleware/app-access";
import { type AuthContext, auth } from "../server/middleware/auth";
import * as rateLimit from "../server/middleware/rate-limit";
import * as accessService from "../services/app-access";
import * as links from "../services/links/runtime";
import * as notifications from "../services/notifications/catalog";
import * as settings from "../services/settings";
import * as applicationPackage from "./application-package";
import { defineApp } from "./define-app";
import { person } from "./define-app.test-fixture";
import * as heartbeat from "./heartbeat";
import * as processSync from "./process-sync";
import * as registry from "./registry";
import * as watcher from "./runtime-watcher";
import * as workload from "./workload-credential";

// Real application startup, live routes, engine, access watchers and Bun sockets;
// external services are stubbed so SIGTERM is covered without test infrastructure.
const report = (event: string, details = {}) => console.log(JSON.stringify({ event, ...details }));
const appId = "live-shutdown";
// Exercise independent owners: this live route authenticates without an app
// access watcher, while the custom socket is registered with app access.
const access = appAccess.roles(["user"], { publicRoutes: ["/api/live-shutdown/live"] });
const unused = (): never => {
  throw new Error("Unexpected Sync operation in shutdown probe");
};
const sync: Sync = {
  ready: async () => {},
  drain: unused,
  health: unused,
  resources: unused,
  controls: unused,
  events: unused,
  topic: unused,
  listTopics: unused,
  queue: unused,
  job: unused,
  ephemeral: unused,
  objectStore: unused,
  mutex: unused,
  pump: unused,
  scheduler: unused,
};
const topic: Topic<LiveEnvelope> = {
  deadLetters: { list: unused, get: unused, delete: unused, replay: unused },
  ready: unused,
  publish: unused,
  publishBatch: unused,
  hub: unused,
  pauseConsumer: unused,
  resumeConsumer: unused,
  latestCursor: unused,
  live: unused,
  destroy: unused,
  process: unused,
  cursorAt: (sequence) => String(sequence),
  cursorSequence: Number,
  head: async () => "0",
  replay: async function* () {},
  follow: async function* ({ signal } = {}) {
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    report("stop-follower");
  },
};
stubConnections();
spyOn(registry, "appRegistry").mockReturnValue({
  ready: unused,
  upsert: unused,
  touch: unused,
  delete: unused,
  snapshot: unused,
  watch: unused,
});
spyOn(applicationPackage, "registerApplicationPackage").mockResolvedValue(undefined);
spyOn(processSync, "startProcessSync").mockImplementation(async () => {
  processSync.bindProcessSync(sync);
  return { sync, stop: async () => report("stop-sync") };
});
spyOn(heartbeat, "createRegistryMembership").mockReturnValue({
  instanceId: "0123456789abcdef",
  register: async () => {},
  leave: async () => report("leave-membership"),
  join: async () => {},
  publish: async () => {},
  adopt: async () => {},
  renew: async () => {},
});
spyOn(heartbeat, "createHeartbeat").mockReturnValue({ start: async () => {}, stop: async () => report("stop-heartbeat") });
spyOn(workload, "createAppWorkloadCredential").mockReturnValue({
  start: async () => {},
  refresh: async () => {},
  stop: async () => report("stop-credential"),
});
spyOn(watcher, "ensureRuntimeWatcher").mockResolvedValue(undefined);
spyOn(watcher, "stopRuntimeWatcher").mockImplementation(async () => report("stop-watcher"));
spyOn(watcher, "getCurrentRuntime").mockReturnValue({ apps: [] });
spyOn(links, "startLinksRuntime").mockResolvedValue(async () => report("stop-links"));
spyOn(notifications, "startNotificationDefinitionRegistration").mockResolvedValue(() => report("stop-notifications"));
spyOn(settings, "loadCache").mockResolvedValue(undefined);
spyOn(settings, "get").mockResolvedValue("en");
spyOn(delivery, "liveTopic").mockReturnValue(topic);
spyOn(delivery, "startLiveDelivery").mockResolvedValue(async () => report("stop-outbox"));
spyOn(accessEvents, "subscribeAppAccessChanged").mockReturnValue(() => report("stop-access-watch"));
spyOn(accessService, "canUseApp").mockResolvedValue(true);
spyOn(registry, "getApp").mockResolvedValue({
  id: appId,
  name: "Shutdown probe",
  icon: "box",
  description: "Shutdown probe",
  baseUrl: "http://shutdown.test:3000",
  routes: ["/api/live-shutdown"],
  access,
});
spyOn(auth, "requireRole").mockImplementation(() => async (c, next) => {
  c.set("actor", { kind: "user", user: person });
  c.set("accessSubject", { type: "user", userId: person.id });
  c.set("credentialKind", "session");
  await next();
});
spyOn(rateLimit, "rateLimit").mockImplementation(() => async (_c, next) => next());

const live = defineLive({ appId, event: z.object({ value: z.string() }) });
const held = Promise.withResolvers<void>();
process.stdin.on("data", () => held.resolve());
const router = new Hono<AuthContext>()
  .route("/api/live-shutdown/live", live.routes({}))
  .get(
    "/api/live-shutdown/custom",
    auth.requireRole("*"),
    upgradeWebSocket((c) => guardAppAccessSocket(c, appId, {})),
  )
  .get("/api/live-shutdown/held", async (c) => {
    report("in-flight");
    await held.promise;
    await sync.ready();
    report("finish-http");
    return c.text("finished");
  });
const app = defineApp({
  id: appId,
  name: "Shutdown probe",
  icon: "box",
  description: "Shutdown probe",
  baseUrl: "http://shutdown.test:3000",
  routes: ["/api/live-shutdown"],
});
const started = await app.start({ fetch: router.fetch, lifecycle: { stop: async () => report("stop-lifecycle") } });
const server = Bun.serve({ ...started, hostname: "127.0.0.1", port: 0, websocket });
process.on("SIGTERM", () => {
  void Promise.resolve(started.fetch(new Request("http://shutdown.test/_cloud/ready"))).then((response) =>
    report("stopping", { status: response.status }),
  );
});
report("listening", { url: server.url.href });
