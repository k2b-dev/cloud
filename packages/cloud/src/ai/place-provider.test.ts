import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { adminAuthority } from "../../../../scripts/fixtures/app-status";
import {
  createAssistantPlaceFixture,
  PLACE_FIXTURE_APP_ID,
  PLACE_FIXTURE_PEOPLE,
  PLACE_FIXTURE_TYPE,
} from "../../../../scripts/fixtures/assistant-place";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { compileCapabilities, invokeCompiledCapability } from "../_internal/capabilities";
import type { RequestActor } from "../server";
import * as logging from "../services/logging";
import { type PlaceProviderOptions, runPlaceProvider } from "./place-provider";

useUnitClients();
afterEach(() => mock.restore());
const actor = (id = PLACE_FIXTURE_PEOPLE.lea): RequestActor => {
  const authority = adminAuthority();
  if (authority.actor.kind !== "user") throw new Error("Fixture user missing");
  return { ...authority.actor, user: { ...authority.actor.user, id } };
};
const harness = () => {
  const fixture = createAssistantPlaceFixture();
  const compiled = compileCapabilities(PLACE_FIXTURE_APP_ID, fixture.capabilities);
  const dispatch = mock<NonNullable<NonNullable<PlaceProviderOptions["dependencies"]>["dispatch"]>>(async (params) => {
    const authority = params.authority!;
    if (authority.actor.kind !== "user") throw new Error("Provider must run as the person");
    const result = await invokeCompiledCapability({
      compiled,
      kind: "query",
      localId: params.capabilityId,
      input: params.input,
      target: params.target,
      expectedSchemaHash: compiled.queries.get(params.capabilityId)!.manifest.schemaHash,
      context: {
        actor: authority.actor,
        user: authority.actor.user,
        authority,
        accessSubject: authority.accessSubject,
        requestId: "fixture-place",
        locale: "en",
        origin: "assistant",
        signal: params.request.signal,
      },
    });
    return result.ok ? Response.json(result.data) : Response.json(result.error, { status: result.error.status });
  });
  const dependencies = {
    getCapability: async () => ({
      appId: PLACE_FIXTURE_APP_ID,
      appName: "Contact fixture",
      appDescription: "Invented contact app",
      appIcon: "ti ti-message",
      endpoint: "http://fixture.test",
      manifest: compiled.manifest,
    }),
    dispatch,
  };
  return { ...fixture, compiled, dependencies, dispatch };
};
const ref = { type: PLACE_FIXTURE_TYPE, id: "marta" };

test("runs the provider as the person at the exact place, with current read/write access", async () => {
  const h = harness();
  expect(await runPlaceProvider(actor(), ref, h)).toMatchObject({ title: "Marta Example", tools: ["reply.set", "note.add"] });
  expect(await runPlaceProvider(actor(PLACE_FIXTURE_PEOPLE.ben), ref, h)).toMatchObject({ title: "Marta Example", tools: [] });
  expect(h.providerCalls).toEqual(["marta", "marta"]);
  expect(h.dispatch.mock.calls[0]![0]).toMatchObject({
    target: ref,
    input: {},
    origin: "assistant",
    authority: { accessSubject: { type: "user", userId: PLACE_FIXTURE_PEOPLE.lea } },
  });
  h.permissions.delete(`${PLACE_FIXTURE_PEOPLE.lea}:marta`);
  expect(await runPlaceProvider(actor(), ref, h)).toEqual({ unavailable: true });
  expect(await runPlaceProvider(actor(), { ...ref, id: "gone" }, h)).toEqual({ unavailable: true });
});

test("drops and logs tool and skill IDs outside the declared superset", async () => {
  const h = harness();
  const warn = mock(() => {});
  const log = logging.logger("fixture-place");
  spyOn(logging, "logger").mockReturnValue({ ...log, warn });
  h.dispatch.mockImplementation(async () =>
    Response.json({
      data: { title: "Marta", context: "Untrusted customer text", tools: ["reply.set", "foreign.action"], skills: ["foreign-skill"] },
    }),
  );
  expect(await runPlaceProvider(actor(), ref, h)).toEqual({
    title: "Marta",
    context: "Untrusted customer text",
    tools: ["reply.set"],
    skills: [],
  });
  expect(warn).toHaveBeenCalledTimes(2);
});

test("invalid, oversized and unavailable provider results all become unavailable", async () => {
  const h = harness();
  for (const patch of [
    { context: "é".repeat(16385) },
    { starters: Array(4).fill({ label: "Ask", prompt: "Question" }) },
    { title: "" },
    { instructions: "Injected" },
  ]) {
    h.dispatch.mockImplementation(async () =>
      Response.json({ data: { title: "Marta", context: "Customer", tools: [], skills: [], ...patch } }),
    );
    expect(await runPlaceProvider(actor(), ref, h)).toEqual({ unavailable: true });
  }
  h.dispatch.mockImplementation(async () => Response.json({ code: "FORBIDDEN", message: "No" }, { status: 403 }));
  expect(await runPlaceProvider(actor(), ref, h)).toEqual({ unavailable: true });
});

test("does not dispatch for types without a valid declaration or for non-person actors", async () => {
  const h = harness();
  expect(
    await runPlaceProvider(
      {
        kind: "service_account",
        delegatedUser: null,
        scopes: [],
        serviceAccount: {
          id: "00000000-0000-4000-8000-000000000003",
          name: "Fixture account",
          kind: "standalone",
          status: "active",
          delegatedUserId: null,
          appId: null,
          resourceType: null,
          resourceId: null,
          createdBy: null,
          createdAt: "2026-11-01T00:00:00Z",
        },
      },
      ref,
      h,
    ),
  ).toEqual({ unavailable: true });
  expect(await runPlaceProvider(actor(), { ...ref, type: "place-fixture.missing" }, h)).toEqual({ unavailable: true });
  expect(h.dispatch).not.toHaveBeenCalled();
});
