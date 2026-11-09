import { afterEach, expect, spyOn, test } from "bun:test";
import { err } from "@k2b/stdlib";
import { z } from "zod";
import { adminAuthority } from "../../../../scripts/fixtures/app-status";
import type { CapabilityAppExecutionContext, CapabilityExecutionContext } from "../contracts/capabilities";
import * as readers from "../services/identity/resource-readers";
import * as identity from "../services/identity/runtime-config";
import { serviceAccounts } from "../services/service-accounts";
import * as users from "../services/session/user";
import { compileCapabilities, invokeCompiledCapability } from "./capabilities";
import { eventPlaceReader } from "./event-place-reader";
import * as principals from "./resource-principals";

const user = adminAuthority().actor;
if (user.kind !== "user") throw new Error("Expected user fixture");
const userPrincipal = { type: "user" as const, userId: user.user.id };
const accountPrincipal = { type: "service_account" as const, serviceAccountId: "11111111-1111-4111-8111-111111111111" };
const context: CapabilityAppExecutionContext = {
  actor: { kind: "app", appId: "consumer" },
  accessSubject: { type: "none" },
  user: null,
  locale: "en",
  requestId: "read-event-place",
  origin: "app",
  signal: new AbortController().signal,
};
const mocks: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore();
});

test("an event place without a batch hook uses its ordinary reader and returns only current readable principals", async () => {
  mocks.push(spyOn(principals, "activeResourcePrincipals").mockImplementation(async (input) => input));
  mocks.push(
    spyOn(readers, "resolveResourceReaders").mockImplementation(async (input) =>
      input.map((principal) => ({
        principal,
        subject:
          principal.type === "user"
            ? { type: "user" as const, userId: principal.userId }
            : { type: "service_account" as const, serviceAccountId: principal.serviceAccountId },
        binding: null,
      })),
    ),
  );
  mocks.push(spyOn(users, "loadCurrentUser").mockResolvedValue(user.user));
  mocks.push(spyOn(identity, "readIdentityGroupsAdmin").mockResolvedValue([]));
  const accountLookup = spyOn(serviceAccounts, "get").mockResolvedValue({
    id: accountPrincipal.serviceAccountId,
    name: "execution account",
    kind: "code",
    status: "active",
    delegatedUserId: null,
    appId: null,
    resourceType: null,
    resourceId: null,
    createdBy: null,
    createdAt: "2026-11-01T00:00:00Z",
  });
  mocks.push(accountLookup);
  const seen: CapabilityExecutionContext[] = [];
  let allowed = true;
  let throwForAccounts = false;
  const compiled = compileCapabilities("provider", {
    protocolVersion: 2,
    types: { collection: { title: "Collection", description: "An event place.", reader: "collection.read" } },
    events: {
      changed: {
        title: "Changed",
        description: "Collection changed.",
        version: 1,
        subject: "collection",
        place: "collection",
        schema: z.strictObject({}),
      },
    },
    queries: {
      "collection.read": {
        title: "Read",
        description: "Read with ordinary grants.",
        openWorld: false,
        input: z.strictObject({ id: z.string().describe("Collection ID.") }),
        data: z.strictObject({ secret: z.string() }),
        run: async (input, projected) => {
          expect(input).toEqual({ id: "known-place" });
          seen.push(projected);
          if (throwForAccounts && projected.actor.kind === "service_account") throw err.forbidden("Not readable");
          return allowed
            ? { ok: true, data: { data: { secret: "never leaves the provider" } } }
            : { ok: false, error: { code: "NOT_FOUND", message: "Missing", status: 404 } };
        },
      },
    },
  });
  const operation = compiled.queries.get("collection.readable");
  expect(operation?.manifest.appOnly).toBe(true);
  expect(compiled.manifest.resourceTypes).toContainEqual({ type: "collection", readable: true });
  const invoke = () =>
    invokeCompiledCapability({
      compiled,
      kind: "query",
      localId: "collection.readable",
      expectedSchemaHash: operation!.manifest.schemaHash,
      input: { id: "known-place", principals: [userPrincipal, accountPrincipal] },
      context,
    });
  expect(await invoke()).toEqual({ ok: true, data: { data: { readable: [userPrincipal, accountPrincipal] } } });
  expect(seen.map((value) => value.accessSubject)).toEqual([
    { type: "user", userId: userPrincipal.userId },
    { type: "service_account", serviceAccountId: accountPrincipal.serviceAccountId },
  ]);
  expect(seen[1]?.actor).toMatchObject({ kind: "service_account", serviceAccount: { kind: "code" }, scopes: ["read"] });
  expect(seen.every((value) => !value.query && !value.idempotencyKey)).toBe(true);
  throwForAccounts = true;
  expect(await invoke()).toEqual({ ok: true, data: { data: { readable: [userPrincipal] } } });
  throwForAccounts = false;
  allowed = false;
  expect(await invoke()).toEqual({ ok: true, data: { data: { readable: [] } } });
  allowed = true;
  // A principal resolved before an account changes must not retain its old user's identity.
  const account = await accountLookup({ id: accountPrincipal.serviceAccountId });
  accountLookup.mockResolvedValue({ ...account!, kind: "user_delegated", delegatedUserId: "22222222-2222-4222-8222-222222222222" });
  const before = seen.length;
  expect(await invoke()).toEqual({ ok: true, data: { data: { readable: [userPrincipal] } } });
  expect(seen).toHaveLength(before + 1);
});

test("a contained event place needs an explicit hook that checks the expected container", () => {
  expect(
    eventPlaceReader(
      {
        protocolVersion: 2,
        types: {
          collection: { title: "Collection", description: "Contained place.", container: "parent", reader: "collection.read" },
          parent: { title: "Parent", description: "A parent." },
        },
        events: {
          changed: {
            title: "Changed",
            description: "Changed place.",
            version: 1,
            subject: "collection",
            place: "collection",
            schema: z.strictObject({}),
          },
        },
        queries: {
          "collection.read": {
            title: "Read",
            description: "Read a place.",
            openWorld: false,
            input: z.strictObject({ id: z.string().describe("ID.") }),
            data: z.strictObject({}),
            run: async () => ({ ok: true, data: { data: {} } }),
          },
        },
      },
      "collection",
    ),
  ).toBeUndefined();
});
