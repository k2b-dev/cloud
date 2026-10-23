import { expect, setSystemTime, spyOn, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import type { Sync } from "@k2b/sync";
import { z } from "zod";
import { env } from "../config/env";
import { appAccess } from "../contracts/app-access";
import { type CapabilityExecutionContext, type CapabilityStream, defineCapabilities } from "../contracts/capabilities";
import type { RequestActor } from "../server/middleware/auth";
import * as invocationActor from "../services/identity/invocation-actor";
import * as invocationToken from "../services/identity/invocation-token";
import * as notificationCatalog from "../services/notifications/catalog";
import * as settingsService from "../services/settings";
import { compileCapabilities } from "./capabilities";
import { defineApp } from "./define-app";
import { inventory, person } from "./define-app.test-fixture";
import * as heartbeat from "./heartbeat";
import { clearProcessApplicationId } from "./process-identity";
import * as processSync from "./process-sync";
import * as registry from "./registry";
import * as watcher from "./runtime-watcher";

test("generated capability routes hand resolved invocation authority to execute, review and every stream handler", async () => {
  const originalSecret = Object.getOwnPropertyDescriptor(env, "APP_SECRET")!;
  Object.defineProperty(env, "APP_SECRET", { value: "authority-test-only", configurable: true });
  const signals = ["SIGTERM", "SIGINT"] as const;
  const previousListeners = signals.map((signal) => new Set(process.listeners(signal)));
  const unused = (): never => {
    throw new Error("Unexpected transport operation");
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
  const contexts: { handler: string; context: CapabilityExecutionContext }[] = [];
  const capture = (handler: string, context: CapabilityExecutionContext) => contexts.push({ handler, context });
  const capabilities = defineCapabilities({
    protocolVersion: 2,
    queries: {
      read: {
        title: "Read",
        description: "Read an item.",
        input: z.object({}).strict(),
        data: z.object({}).strict(),
        openWorld: false,
        run: async (_input, context) => {
          capture("query", context);
          return ok({ data: {} });
        },
        stream: {
          direction: "read",
          maxBytes: 1,
          read: async (_stream, context) => {
            capture("stream.read", context);
            return new Response("x");
          },
        },
      },
    },
    actions: {
      update: {
        title: "Update",
        description: "Update an item.",
        input: z.object({}).strict(),
        data: z.object({}).strict(),
        destructive: false,
        openWorld: false,
        idempotency: "none",
        run: async (_input, context) => {
          capture("action", context);
          return ok({ data: {} });
        },
        review: async (_input, context) => {
          capture("review", context);
          return ok({ message: "Update item?" });
        },
      },
      upload: {
        title: "Upload",
        description: "Upload an item.",
        input: z.object({}).strict(),
        data: z.object({}).strict(),
        destructive: false,
        openWorld: false,
        idempotency: "required",
        run: async () => ok({ data: {} }),
        stream: {
          direction: "write",
          maxBytes: 1,
          write: async (_stream, body, context) => {
            expect(await new Response(body).text()).toBe("x");
            capture("stream.write", context);
            return { data: {} };
          },
          status: async (_stream, context) => {
            capture("stream.status", context);
            return { state: "open" };
          },
          abort: async (_stream, context) => {
            capture("stream.abort", context);
          },
        },
      },
    },
  });
  const manifest = compileCapabilities(inventory.id, capabilities).manifest;
  const mobileActor: RequestActor = {
    kind: "user",
    user: person,
    sessionKind: "app",
    delegation: { kind: "invocation", callingAppId: "core", credentialKind: "session", invocationId: "authority-test" },
  };
  const scopedActor: RequestActor = {
    kind: "service_account",
    serviceAccount: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Test",
      kind: "standalone",
      status: "active",
      delegatedUserId: null,
      appId: null,
      resourceType: null,
      resourceId: null,
      createdBy: null,
      createdAt: "2026-10-20T00:00:00Z",
    },
    delegatedUser: null,
    scopes: ["read", "write", "inventory:read"],
    delegation: { kind: "invocation", callingAppId: "core", credentialKind: "oauth", invocationId: "authority-test" },
  };
  const authorities: invocationActor.ResolvedInvocationAuthority[] = [
    { actor: mobileActor, accessSubject: { type: "user", userId: person.id }, credentialKind: "invocation", scopes: [] },
    {
      actor: scopedActor,
      accessSubject: { type: "service_account", serviceAccountId: scopedActor.serviceAccount.id },
      credentialKind: "invocation",
      scopes: scopedActor.scopes,
    },
  ];
  let resolved = authorities[0]!;
  const candidate = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "test", typ: "cloud-invocation+jwt" })).toString("base64url")}.e30.signature`;
  const verify = spyOn(invocationToken, "verifyInvocationToken").mockImplementation(async (_token, expectation) => ({
    iss: "https://cloud.example",
    aud: `app:${expectation.targetAppId}`,
    token_use: "invocation",
    sub: resolved.actor.kind === "user" ? resolved.actor.user.id : resolved.actor.serviceAccount.id,
    principal_type: resolved.actor.kind,
    access_subject_type: resolved.accessSubject.type,
    access_subject_id: resolved.accessSubject.type === "user" ? resolved.accessSubject.userId : resolved.accessSubject.serviceAccountId,
    act: { sub: "app:core" },
    credential_kind: resolved.actor.delegation!.credentialKind,
    scopes: resolved.scopes,
    op: expectation.operation,
    schema_hash: expectation.schemaHash,
    ver: 1,
    jti: "33333333-3333-4333-8333-333333333333",
    iat: 100,
    nbf: 100,
    exp: 130,
  }));
  const resolve = spyOn(invocationActor, "resolveInvocationAuthority").mockImplementation(async () => resolved);
  const spies = [
    verify,
    resolve,
    spyOn(settingsService, "get").mockResolvedValue("en"),
    spyOn(settingsService, "loadCache").mockResolvedValue(undefined),
    spyOn(processSync, "startProcessSync").mockImplementation(async () => {
      processSync.bindProcessSync(sync);
      return { sync, stop: async () => processSync.unbindProcessSync() };
    }),
    spyOn(registry, "appRegistry").mockReturnValue({
      ready: unused,
      upsert: unused,
      touch: unused,
      delete: unused,
      snapshot: unused,
      watch: unused,
    }),
    spyOn(registry, "capabilityRegistry").mockReturnValue({
      ready: unused,
      upsert: unused,
      touch: unused,
      delete: unused,
      snapshot: unused,
      watch: unused,
    }),
    spyOn(heartbeat, "createHeartbeat").mockReturnValue({ start: async () => {}, stop: async () => {} }),
    spyOn(watcher, "ensureRuntimeWatcher").mockResolvedValue(undefined),
    spyOn(watcher, "stopRuntimeWatcher").mockResolvedValue(undefined),
    spyOn(watcher, "getCurrentRuntime").mockReturnValue({ apps: [] }),
    spyOn(notificationCatalog, "startNotificationDefinitionRegistration").mockResolvedValue(() => {}),
  ];
  try {
    setSystemTime(new Date("2026-10-22T12:00:00Z"));
    const app = defineApp({ ...inventory, access: appAccess.signedIn() });
    const started = await app.start({ fetch: () => new Response("not a capability", { status: 404 }), capabilities });
    const request = (path: string, hash: string, stream?: CapabilityStream) =>
      started.fetch(
        new Request(`http://inventory/api/_internal/capabilities/v1/${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${candidate}`,
            "x-cloud-capability-schema-hash": hash,
            ...(stream ? { "x-cloud-stream-offer": Buffer.from(JSON.stringify(stream)).toString("base64url") } : {}),
          },
          body: path.endsWith("/write") ? "x" : '{"input":{}}',
        }),
      );
    for (const authority of authorities) {
      resolved = authority;
      contexts.length = 0;
      const queryHash = manifest.queries[0]!.schemaHash;
      const actionHash = manifest.actions.find((action) => action.localId === "update")!.schemaHash;
      const uploadHash = manifest.actions.find((action) => action.localId === "upload")!.schemaHash;
      for (const [path, hash] of [
        ["queries/read", queryHash],
        ["actions/update", actionHash],
        ["actions/update/review", actionHash],
      ]) {
        const response = await request(path!, hash!);
        expect(response.status).toBe(200);
        await response.json();
      }
      for (const [kind, id, verb, hash] of [
        ["queries", "read", "read", queryHash],
        ["actions", "upload", "write", uploadHash],
        ["actions", "upload", "status", uploadHash],
        ["actions", "upload", "abort", uploadHash],
      ] as const) {
        const response = await request(`streams/${kind}/${id}/${verb}`, hash, {
          id: "stream",
          direction: kind === "queries" ? "read" : "write",
          mediaType: "text/plain",
          size: 1,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        expect(response.status).toBe(200);
        await response.text();
      }
      expect(contexts.map(({ handler }) => handler)).toEqual([
        "query",
        "action",
        "review",
        "stream.read",
        "stream.write",
        "stream.status",
        "stream.abort",
        "stream.status",
      ]);
      for (const { context } of contexts) {
        expect(context.authority).toEqual(authority);
        expect(context.authority?.actor).toBe(authority.actor);
        expect(context.authority?.accessSubject).toBe(authority.accessSubject);
        expect(context.actor).toBe(authority.actor);
        expect(context.accessSubject).toBe(authority.accessSubject);
      }
    }
    resolved = { ...resolved, scopes: ["other:read"] };
    const beforeDenied = contexts.length;
    expect((await request("queries/read", manifest.queries[0]!.schemaHash)).status).toBe(403);
    expect(contexts).toHaveLength(beforeDenied);
    expect(verify).toHaveBeenCalledTimes(15);
    expect(resolve).toHaveBeenCalledTimes(15);
  } finally {
    for (const [index, signal] of signals.entries())
      for (const listener of process.listeners(signal)) if (!previousListeners[index]!.has(listener)) process.off(signal, listener);
    setSystemTime();
    processSync.unbindProcessSync();
    clearProcessApplicationId();
    for (const spy of spies.toReversed()) spy.mockRestore();
    Object.defineProperty(env, "APP_SECRET", originalSecret);
  }
});
