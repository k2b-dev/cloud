import { describe, expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { compileCapabilities } from "../_internal/capabilities";
import { defineCapabilities } from "../contracts/capabilities";
import type { CapabilityRegistryEntry } from "../contracts/registry";
import type { AuthContext } from "../server";
import { createAiApprovalPreferenceRoutes } from "./approval-routes";
import { AI_WEBSITE_APPROVAL_TOOL, type AiToolApprovalPreference, aiWebsiteApprovalScope } from "./approvals";
import { aiCapabilityId } from "./capabilities";

const userId = "11111111-1111-4111-8111-111111111111";
const preferenceId = "22222222-2222-4222-8222-222222222222";

const authenticate: MiddlewareHandler<AuthContext> = async (c, next) => {
  const user = { id: userId, roles: ["user"] } as AuthContext["Variables"]["user"];
  c.set("actor", { kind: "user", user });
  c.set("accessSubject", { type: "user", userId });
  c.set("user", user);
  await next();
};

const pass: MiddlewareHandler<AuthContext> = async (_c, next) => next();

const capabilityManifest = compileCapabilities(
  "demo",
  defineCapabilities({
    protocolVersion: 2,
    types: { item: { title: "Item", description: "A test item." } },
    actions: {
      rename: {
        title: "Rename item",
        description: "Renames one item.",
        input: z.object({ id: z.string().describe("Item id."), name: z.string().describe("New item name.") }).strict(),
        data: z.object({ id: z.string() }).strict(),
        destructive: false,
        openWorld: false,
        idempotency: "required",
        approval: "rememberable",
        review: async () => ({ ok: true, data: { message: "Rename the item." } }),
        run: async ({ id }) => ok({ data: { id } }),
      },
    },
  }),
).manifest;

const capabilityApp: CapabilityRegistryEntry = {
  appId: "demo",
  appName: "Demo",
  appIcon: "ti ti-box",
  appAccent: "#336699",
  appDescription: "Demo app",
  endpoint: "http://demo:3000/api/_internal/capabilities/v1",
  manifest: capabilityManifest,
};

const preference: AiToolApprovalPreference = {
  id: preferenceId,
  toolName: aiCapabilityId("demo", "rename"),
  approvalScope: "demo.rename",
  conversationId: null,
  createdAt: "2026-08-05T12:00:00.000Z",
  lastUsedAt: "2026-08-05T12:05:00.000Z",
  expiresAt: null,
};

describe("AI approval preference routes", () => {
  test("lists current-user preferences with live capability presentation", async () => {
    const routes = createAiApprovalPreferenceRoutes({
      limit: pass,
      authenticate,
      listPreferences: async (actorUserId) => {
        expect(actorUserId).toBe(userId);
        return [preference];
      },
      listCapabilities: async () => [capabilityApp],
    });

    const response = await routes.request("/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      approvals: [
        {
          ...preference,
          title: "Rename item",
          app: { id: "demo", name: "Demo", icon: "ti ti-box", accent: "#336699" },
          website: null,
        },
      ],
    });
  });

  test("lists one chat's approvals only for a chat the user owns, and names a website by its host", async () => {
    const conversationId = "33333333-3333-4333-8333-333333333333";
    const asked: Array<{ conversationId?: string }> = [];
    const routes = createAiApprovalPreferenceRoutes({
      limit: pass,
      authenticate,
      listPreferences: async (_actorUserId, options) => {
        asked.push(options);
        return [
          {
            ...preference,
            toolName: AI_WEBSITE_APPROVAL_TOOL,
            approvalScope: "https://query1.finance.yahoo.com",
            conversationId,
          },
        ];
      },
      listCapabilities: async () => [],
      findConversation: async (ownerUserId, conversation) =>
        ownerUserId === userId && conversation === "abc234" ? { id: conversationId } : null,
    });

    const response = await routes.request("/?conversation=abc234");
    expect(response.status).toBe(200);
    expect(asked).toEqual([{ conversationId }]);
    expect(((await response.json()) as { approvals: unknown[] }).approvals[0]).toMatchObject({
      title: "query1.finance.yahoo.com",
      conversationId,
      website: { origin: "https://query1.finance.yahoo.com", resourceId: null },
    });
    expect((await routes.request("/?conversation=other1")).status).toBe(404);
    expect(asked).toHaveLength(1);
  });

  test("names the Studio app a website approval is limited to", async () => {
    const routes = createAiApprovalPreferenceRoutes({
      limit: pass,
      authenticate,
      listPreferences: async () => [
        { ...preference, toolName: AI_WEBSITE_APPROVAL_TOOL, approvalScope: aiWebsiteApprovalScope("https://api.example.com", "Ab3dEf") },
      ],
      listCapabilities: async () => [],
    });
    const body = (await (await routes.request("/")).json()) as { approvals: unknown[] };
    expect(body.approvals[0]).toMatchObject({
      title: "api.example.com",
      website: { origin: "https://api.example.com", resourceId: "Ab3dEf" },
    });
  });

  test("titles remembered approvals in the request locale", async () => {
    const localized = compileCapabilities(
      "demo",
      defineCapabilities({
        protocolVersion: 2,
        presentation: {
          baseLocale: "en",
          translations: { de: { actions: { rename: { title: "Element umbenennen", description: "Benennt ein Element um." } } } },
        },
        types: { item: { title: "Item", description: "A test item." } },
        actions: {
          rename: {
            title: "Rename item",
            description: "Renames one item.",
            input: z.object({ id: z.string().describe("Item id.") }).strict(),
            data: z.object({ id: z.string() }).strict(),
            destructive: false,
            openWorld: false,
            idempotency: "required",
            approval: "rememberable",
            review: async () => ({ ok: true, data: { message: "Rename the item.", approvalScope: "demo" } }),
            run: async ({ id }) => ok({ data: { id } }),
          },
        },
      }),
    );
    const routes = createAiApprovalPreferenceRoutes({
      limit: pass,
      authenticate,
      listPreferences: async () => [preference],
      listCapabilities: async () => [
        {
          ...capabilityApp,
          manifest: localized.manifest,
          presentation: localized.presentation,
          appPresentation: { baseLocale: "en", translations: { de: { name: "Beispiel" } } },
        },
      ],
    });
    const list = async (language: string) =>
      (
        (await (await routes.request("/", { headers: { "accept-language": language } })).json()) as {
          approvals: Array<{ title: string; app: { name: string } | null }>;
        }
      ).approvals[0];
    expect(await list("de-DE,de;q=0.9")).toMatchObject({ title: "Element umbenennen", app: { name: "Beispiel" } });
    expect(await list("en")).toMatchObject({ title: "Rename item", app: { name: "Demo" } });
  });

  test("keeps preferences manageable while the capability registry is unavailable", async () => {
    const routes = createAiApprovalPreferenceRoutes({
      limit: pass,
      authenticate,
      listPreferences: async () => [preference],
      listCapabilities: async () => {
        throw new Error("registry offline");
      },
    });

    const response = await routes.request("/");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { approvals: Array<{ title: string; app: unknown }> };
    expect(body.approvals[0]).toMatchObject({ title: "Demo rename", app: null });
  });

  test("revokes only through the current user's ownership boundary", async () => {
    let revoked: { actorUserId: string; id: string } | undefined;
    const routes = createAiApprovalPreferenceRoutes({
      limit: pass,
      authenticate,
      revokePreference: async (actorUserId, id) => {
        revoked = { actorUserId, id };
        return true;
      },
    });

    const response = await routes.request(`/${preferenceId}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(revoked).toEqual({ actorUserId: userId, id: preferenceId });
  });

  test("returns not found without exposing another user's preference", async () => {
    const routes = createAiApprovalPreferenceRoutes({
      limit: pass,
      authenticate,
      revokePreference: async () => false,
    });
    const response = await routes.request(`/${preferenceId}`, { method: "DELETE" });
    expect(response.status).toBe(404);
  });
});
