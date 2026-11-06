import { afterEach, expect, spyOn, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { z } from "zod";
import { hostFetch } from "../packages/assistant/src/artifacts/agent-host";
import { createArtifactServiceRoutes } from "../packages/assistant/src/artifacts/api";
import { runtimeCapabilities } from "../packages/assistant/src/artifacts/capability-runtime";
import { testIdentity } from "../packages/assistant/src/artifacts/test-identity";
import * as registry from "../packages/cloud/src/_internal/registry";
import * as cloudAi from "../packages/cloud/src/ai/index.ts";
import { aiConversations } from "../packages/cloud/src/ai/index.ts";
import * as capabilityClient from "../packages/cloud/src/capabilities/server.ts";
import { compileCapabilityManifest } from "../packages/cloud/src/capabilities/testing.ts";
import { defineCapabilities } from "../packages/cloud/src/contracts/index.ts";
import type { AppRegistryEntry, CapabilityRegistryEntry } from "../packages/cloud/src/contracts/registry";
import type { AuthContext, RequestAuthority } from "../packages/cloud/src/server/index.ts";

const identity = testIdentity("11111111-1111-4111-8111-111111111111");
const conversationId = "22222222-2222-4222-8222-222222222222";
const at = "2026-10-01T00:00:00.000Z";
const authority: RequestAuthority = {
  actor: {
    kind: "user",
    user: identity.user,
    delegation: { kind: "invocation", callingAppId: "core", credentialKind: "oauth", invocationId: "runtime-test" },
  },
  accessSubject: identity.accessSubject,
  credentialKind: "invocation",
  scopes: ["demo:read"],
};
const mobileAuthority: RequestAuthority = {
  actor: {
    kind: "user",
    user: identity.user,
    sessionKind: "app",
    delegation: { kind: "invocation", callingAppId: "core", credentialKind: "session", invocationId: "mobile-runtime-test" },
  },
  accessSubject: identity.accessSubject,
  credentialKind: "invocation",
  scopes: [],
};
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
function setup() {
  const manifest = compileCapabilityManifest(
    "demo",
    defineCapabilities({
      protocolVersion: 2,
      queries: {
        read: {
          title: "Read item",
          description: "Read an item.",
          input: z.object({}).strict(),
          data: z.object({}),
          openWorld: false,
          run: async () => ok({ data: {} }),
        },
      },
      actions: {
        write: {
          title: "Write item",
          description: "Write an item.",
          input: z.object({}).strict(),
          data: z.object({}),
          approval: "rememberable",
          idempotency: "required",
          destructive: false,
          openWorld: false,
          review: async () => ok({ message: "Write item?" }),
          run: async () => ok({ data: {} }),
        },
      },
    }),
  );
  const app: AppRegistryEntry = {
    id: "demo",
    name: "Demo",
    description: "",
    icon: "",
    routes: [],
    baseUrl: "http://demo.invalid",
    access: { kind: "signedIn" },
  };
  const capability: CapabilityRegistryEntry = {
    appId: app.id,
    appName: app.name,
    appIcon: app.icon,
    appDescription: "",
    endpoint: "/demo",
    manifest,
  };
  spies.push(spyOn(registry, "getApp").mockImplementation(async () => app));
  spies.push(spyOn(registry, "getCapability").mockResolvedValue(capability));
  spies.push(
    spyOn(aiConversations, "getConversation").mockResolvedValue({
      id: conversationId,
      shortId: "Cht234",
      title: "Chat",
      titleSource: "user",
      description: "",
      descriptionSource: "user",
      keywords: [],
      pinnedAt: null,
      done: null,
      isDone: false,
      lastUsedAt: at,
      archivedAt: null,
      runStatus: "idle",
      runError: null,
      unreadCompletion: false,
      projectId: null,
      draft: { content: [], revision: 1, updatedAt: null },
      createdByUserId: identity.user.id,
      createdAt: at,
      updatedAt: at,
    }),
  );
  return { app };
}

test("Studio check route keeps resolved invocation scopes/mobile limits and hides the target after access is revoked", async () => {
  const { app } = setup();
  const prepare = spyOn(runtimeCapabilities, "prepare").mockResolvedValue({
    status: "completed",
    result: { ok: true, data: { data: { answer: 42 } } },
  });
  spies.push(prepare);
  let current = authority;
  const router = new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.set("actor", current.actor);
      c.set("accessSubject", current.accessSubject);
      c.set("credentialKind", current.credentialKind);
      c.set("credentialScopes", current.scopes);
      await next();
    })
    .route("/", createArtifactServiceRoutes());
  const request = () =>
    router.request("/runtime/check/capability", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo.read", input: {}, conversationId }),
    });
  expect(await (await request()).json()).toMatchObject({ data: { answer: 42 } });
  expect(prepare.mock.calls[0]?.[1].authority).toEqual(authority);
  expect(prepare.mock.calls[0]?.[1].authority?.actor).toBe(authority.actor);
  app.access = { kind: "roles", roles: ["admin"] };
  expect((await request()).status).toBe(404);
  expect(prepare).toHaveBeenCalledTimes(1);
  app.access = { kind: "signedIn" };
  current = { ...authority, scopes: ["core:read"] };
  expect((await request()).status).toBe(404);
  expect(prepare).toHaveBeenCalledTimes(1);
  current = mobileAuthority;
  expect((await request()).status).toBe(200);
  expect(prepare.mock.calls[1]?.[1].authority).toEqual(mobileAuthority);
  app.access = { kind: "roles", roles: ["admin"] };
  expect((await request()).status).toBe(404);
  expect(prepare).toHaveBeenCalledTimes(2);
});

test("Studio prepare reaches a declared app review only with actual authority and rechecks changed access", async () => {
  const { app } = setup();
  const reviewed = new Error("Review reached with authorized metadata");
  const review = spyOn(capabilityClient, "reviewCapabilityAction").mockRejectedValue(reviewed);
  spies.push(review);
  const input = { id: "33333333-3333-4333-8333-333333333333", name: "demo.write", input: {}, conversationId };
  const caller = {
    locale: "de",
    transport: async () => {
      throw new Error("Unexpected execution");
    },
  };
  await expect(runtimeCapabilities.prepare(input, { ...identity, authority }, caller)).rejects.toBe(reviewed);
  expect(review).toHaveBeenCalledTimes(1);
  app.access = { kind: "roles", roles: ["admin"] };
  await expect(runtimeCapabilities.prepare(input, { ...identity, authority }, caller)).rejects.toMatchObject({ code: "NOT_FOUND" });
  app.access = { kind: "signedIn" };
  await expect(runtimeCapabilities.prepare(input, identity, caller)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(review).toHaveBeenCalledTimes(1);
});

test("managed host carries its verified invocation authority through the local check route", async () => {
  const { app } = setup();
  const context = {
    ...identity,
    authority: mobileAuthority,
    actor: mobileAuthority.actor,
    conversationId,
    locale: "en",
    timeZone: "UTC",
    signal: new AbortController().signal,
  };
  const turnId = "44444444-4444-4444-8444-444444444444";
  const chat = await aiConversations.getConversation({ conversationId });
  if (!chat) throw new Error("Missing chat fixture");
  spies.push(
    spyOn(cloudAi, "authorizeCodeExecution").mockResolvedValue({
      conversation: chat,
      turn: {
        id: turnId,
        shortId: "Trn234",
        conversationId,
        status: "running",
        attempt: 1,
        modelId: null,
        createdAt: at,
        completedAt: null,
        error: null,
      },
      config: { kind: "chat", input: "Run" },
    }),
  );
  const prepare = spyOn(runtimeCapabilities, "prepare").mockResolvedValue({
    status: "completed",
    result: { ok: true, data: { data: {} } },
  });
  spies.push(prepare);
  const session: Parameters<typeof hostFetch>[1] = {
    phase: "running",
    id: "55555555-5555-4555-8555-555555555555",
    key: conversationId,
    conversationId,
    turnId,
    background: false,
    context,
    lastUsed: Date.parse(at),
    busy: new Set(),
    checks: new Map(),
    checkScopes: new Set(),
    decisions: new Map(),
    capabilityTransport: async () => {
      throw new Error("Unexpected dispatch");
    },
    host: Promise.resolve({ health: async () => {}, execute: async () => null, call: async () => null, close: async () => {} }),
  };
  const request = () =>
    hostFetch(context, session, "/api/assistant/artifacts/runtime/check/capability", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo.read", input: {}, conversationId }),
    });
  expect((await request()).status).toBe(200);
  expect(prepare.mock.calls[0]?.[1].authority).toEqual(mobileAuthority);
  expect(prepare.mock.calls[0]?.[2].transport).toBe(session.capabilityTransport);
  app.access = { kind: "roles", roles: ["admin"] };
  expect((await request()).status).toBe(404);
  expect(prepare).toHaveBeenCalledTimes(1);
});
