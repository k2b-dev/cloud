import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { compileCapabilities } from "../_internal/capabilities";
import { defineCapabilities } from "../contracts/capabilities";
import type { CapabilityRegistryEntry } from "../contracts/registry";
import type { AuthContext } from "../server";
import { aiProjects } from "./projects";
import { __buildAiProjectsRoutesForTest } from "./projects-routes";

const userId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const projectShortId = "pRk234";

const authenticate: MiddlewareHandler<AuthContext> = async (c, next) => {
  const user = { id: userId, roles: ["user"] } as AuthContext["Variables"]["user"];
  c.set("actor", { kind: "user", user });
  c.set("accessSubject", { type: "user", userId });
  c.set("user", user);
  await next();
};

const pass: MiddlewareHandler<AuthContext> = async (_c, next) => next();

const capabilityEntry = (reader = true): CapabilityRegistryEntry => {
  const manifest = compileCapabilities(
    "contacts",
    defineCapabilities({
      protocolVersion: 2,
      types: {
        contact: {
          title: "Contact",
          description: "One contact.",
          ...(reader ? { reader: "contact.read" } : {}),
        },
      },
      ...(reader
        ? {
            queries: {
              "contact.read": {
                title: "Read contact",
                description: "Read one contact.",
                input: z.object({ id: z.string().describe("Stable contact id.") }).strict(),
                data: z.object({ id: z.string() }).strict(),
                openWorld: false,
                run: async ({ id }: { id: string }) => ok({ data: { id } }),
              },
            },
          }
        : {}),
    }),
  ).manifest;
  return {
    appId: "contacts",
    appName: "Contacts",
    appIcon: "ti ti-address-book",
    appDescription: "Contacts",
    endpoint: "http://contacts/api/_internal/capabilities/v1",
    manifest,
  };
};

afterEach(() => {
  mock.restore();
});

describe("AI Project reference routes", () => {
  test("allows anonymous mutations through an explicit public write grant", async () => {
    spyOn(aiProjects, "getByShortId").mockResolvedValue({ id: projectId, shortId: projectShortId, permission: "write" } as never);
    spyOn(aiProjects, "createKnowledge").mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      shortId: "kNo234",
      projectId,
      title: "Public",
      content: "Shared",
      createdAt: "2026-08-11T10:00:00.000Z",
      updatedAt: "2026-08-11T10:00:00.000Z",
    });
    const routes = __buildAiProjectsRoutesForTest({ limit: pass, authenticate: pass });

    const response = await routes.request(`/${projectShortId}/knowledge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Public", content: "Shared" }),
    });

    expect(response.status).toBe(201);
    expect(aiProjects.getByShortId).toHaveBeenCalledWith(projectShortId, null, "write");
    expect(aiProjects.createKnowledge).toHaveBeenCalledWith(projectId, null, { title: "Public", content: "Shared" });
  });

  test("checks Project write access before consulting the capability registry", async () => {
    spyOn(aiProjects, "getByShortId").mockResolvedValue(null);
    let registryCalls = 0;
    const routes = __buildAiProjectsRoutesForTest({
      limit: pass,
      authenticate,
      getCapability: async () => {
        registryCalls += 1;
        return capabilityEntry();
      },
    });

    const response = await routes.request(`/${projectShortId}/references`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: { type: "contacts.contact", id: "contact-1" } }),
    });
    expect(response.status).toBe(404);
    expect(registryCalls).toBe(0);
  });

  test("distinguishes registry unavailability from invalid and valid refs", async () => {
    spyOn(aiProjects, "getByShortId").mockResolvedValue({ id: projectId, shortId: projectShortId } as never);
    const unavailable = __buildAiProjectsRoutesForTest({
      limit: pass,
      authenticate,
      getCapability: async () => {
        throw new Error("offline");
      },
    });
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: { type: "contacts.contact", id: "contact-1" } }),
    };
    expect((await unavailable.request(`/${projectShortId}/references`, request)).status).toBe(503);

    const invalid = __buildAiProjectsRoutesForTest({
      limit: pass,
      authenticate,
      getCapability: async () => capabilityEntry(false),
    });
    expect((await invalid.request(`/${projectShortId}/references`, request)).status).toBe(400);

    spyOn(aiProjects, "createReference").mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      shortId: "rEf234",
      projectId,
      ref: { type: "contacts.contact", id: "contact-1" },
      label: "Ada",
      createdAt: "2026-08-11T10:00:00.000Z",
    });
    const valid = __buildAiProjectsRoutesForTest({ limit: pass, authenticate, getCapability: async () => capabilityEntry() });
    const response = await valid.request(`/${projectShortId}/references`, {
      ...request,
      body: JSON.stringify({ ref: { type: "contacts.contact", id: "contact-1" }, label: "Ada" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      reference: { id: "rEf234", projectId: projectShortId, ref: { type: "contacts.contact", id: "contact-1" }, label: "Ada" },
    });
  });
});
