import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { adminAuthority } from "../../../../../scripts/fixtures/app-status";
import * as registry from "../../_internal/registry";
import { compileCapabilityManifest } from "../../capabilities/testing";
import type { AppEventEnvelope } from "../../contracts/app-events";
import { AppAccessDeniedError } from "../../server/middleware/app-access";
import * as identity from "../identity/issue-invocation";
import { type Mandate, mandates } from "../mandates";
import { authorizeResourceEvent, type ResourceEventBinding } from "./resources";

const id = "11111111-1111-4111-8111-111111111111";
const place = { type: "fixture.collection", id: "collection-a" };
const binding: ResourceEventBinding = { consumer: "fixture", key: "one", revision: "v1", mandateId: id, mandateRevision: 1, place };
const event: AppEventEnvelope = {
  id,
  type: "fixture.changed",
  source: "fixture",
  version: 1,
  time: "2026-01-01T00:00:00Z",
  subject: { type: "fixture.item", id: "item-a" },
  place,
  data: {},
};
const mandate: Mandate = {
  id,
  subject: { type: "user", id },
  ownerAppId: "consumer",
  workloadType: "fixture",
  workloadId: "one",
  policy: { version: 1, apps: [], operations: [], actions: "deny" },
  state: "active",
  revision: 1,
  expiresAt: null,
  confirmedAt: "2026-01-01T00:00:00Z",
  confirmationDeadline: null,
  createdByUserId: id,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  revokedAt: null,
  revokedByUserId: null,
  revokedByAppId: null,
  revokeReason: null,
};
const manifest = compileCapabilityManifest("fixture", {
  protocolVersion: 2,
  types: { collection: { title: "Collection", description: "Fixture collection.", reader: "collection.read" } },
  queries: {
    "collection.read": {
      title: "Read",
      description: "Read fixture.",
      openWorld: false,
      input: z.strictObject({ id: z.string().describe("Collection ID.") }),
      data: z.object({}),
      run: async () => ({ ok: true, data: { data: {} } }),
    },
  },
});
let clock: ReturnType<typeof spyOn<typeof Date, "now">>;
let load: ReturnType<typeof spyOn<typeof mandates, "get">>;
let resolve: ReturnType<typeof spyOn<typeof identity, "resolveIssuanceAuthority">>;
let access: ReturnType<typeof spyOn<typeof identity, "issueInvocationToken">>;
let lookup: ReturnType<typeof spyOn<typeof registry, "getCapability">>;
let invoke: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
beforeEach(() => {
  clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-06T12:00:00Z"));
  load = spyOn(mandates, "get").mockResolvedValue(mandate);
  // The reader receives exactly the currently resolved authority, with no publisher identity.
  resolve = spyOn(identity, "resolveIssuanceAuthority").mockResolvedValue(adminAuthority());
  access = spyOn(identity, "issueInvocationToken").mockResolvedValue({
    token: "fixture",
    claims: {
      iss: "https://cloud.example",
      aud: "app:fixture",
      token_use: "invocation",
      sub: id,
      principal_type: "user",
      access_subject_type: "user",
      access_subject_id: id,
      act: { sub: "app:consumer" },
      credential_kind: "session",
      scopes: [],
      op: "capability.query:collection.read",
      schema_hash: null,
      ver: 1,
      jti: id,
      iat: 0,
      nbf: 0,
      exp: 30,
    },
  });
  lookup = spyOn(registry, "getCapability").mockResolvedValue({
    appId: "fixture",
    appName: "Fixture",
    appDescription: "Fixture",
    appIcon: "box",
    endpoint: "http://fixture",
    manifest,
  });
  invoke = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: {} }));
});
afterEach(() => {
  clock.mockRestore();
  load.mockRestore();
  resolve.mockRestore();
  access.mockRestore();
  lookup.mockRestore();
  invoke.mockRestore();
});
test("only the subscribed place is read under current mandate identity", async () => {
  expect(await authorizeResourceEvent("consumer", binding, event)).toBe(true);
  expect(resolve.mock.calls[0]?.[0]).toMatchObject({ sub: id, principal_type: "user", credential_kind: "mandate" });
  expect(invoke.mock.calls[0]?.[0]).toBe("http://fixture/queries/collection.read");
  expect(JSON.parse(String(invoke.mock.calls[0]?.[1]?.body))).toEqual({ input: { id: "collection-a" } });
  expect(access.mock.calls[0]?.[0]).toMatchObject({
    operation: "capability.query:collection.read",
    authority: { mandate_id: id, workload_event: id },
  });
  expect(await authorizeResourceEvent("consumer", binding, { ...event, place: { ...place, id: "other" } })).toBe(false);
  expect(invoke).toHaveBeenCalledTimes(1);
});
test.each(["paused", "revoked"] as const)("%s mandate prevents delivery", async (state) => {
  load.mockResolvedValue({ ...mandate, state });
  expect(await authorizeResourceEvent("consumer", binding, event)).toBe(false);
  expect(invoke).not.toHaveBeenCalled();
});
test("changed revision, unconfirmed, expired or foreign mandate prevents delivery", async () => {
  for (const change of [{ revision: 2 }, { confirmedAt: null }, { expiresAt: "2000-01-01T00:00:00Z" }, { ownerAppId: "other" }]) {
    load.mockResolvedValue({ ...mandate, ...change });
    expect(await authorizeResourceEvent("consumer", binding, event)).toBe(false);
  }
  expect(invoke).not.toHaveBeenCalled();
});
test("a negative reader answer cancels; an unavailable reader retries", async () => {
  invoke.mockImplementation(async () => Response.json({ code: "FORBIDDEN", message: "Denied" }, { status: 403 }));
  expect(await authorizeResourceEvent("consumer", binding, event)).toBe(false);
  invoke.mockImplementation(async () => Response.json({ code: "APP_UNAVAILABLE", message: "Unavailable" }, { status: 503 }));
  await expect(authorizeResourceEvent("consumer", binding, event)).rejects.toThrow("APP_UNAVAILABLE");
  resolve.mockResolvedValue(null);
  expect(await authorizeResourceEvent("consumer", binding, event)).toBe(false);
});

test("lost app access cancels without calling the reader", async () => {
  access.mockRejectedValue(new AppAccessDeniedError({ id: "consumer" }));
  expect(await authorizeResourceEvent("consumer", binding, event)).toBe(false);
  expect(invoke).not.toHaveBeenCalled();
});
test("an aborted delivery never reads or invokes the subscriber", async () => {
  await expect(authorizeResourceEvent("consumer", binding, event, AbortSignal.abort())).rejects.toThrow();
  expect(load).not.toHaveBeenCalled();
});
