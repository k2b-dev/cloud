import { afterEach, expect, spyOn, test } from "bun:test";
import { err } from "@k2b/stdlib";
import { z } from "zod";
import { adminAuthority } from "../../../../scripts/fixtures/app-status";
import type { CapabilityAppExecutionContext, CapabilityDefinitions, CapabilityExecutionContext } from "../contracts/capabilities";
import * as readers from "../services/identity/resource-readers";
import * as identity from "../services/identity/runtime-config";
import { serviceAccounts } from "../services/service-accounts";
import * as users from "../services/session/user";
import { compileCapabilities, invokeCompiledCapability } from "./capabilities";
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

const containedPlace = (
  run: (input: { id: string }, projected: CapabilityExecutionContext) => Promise<unknown>,
  access?: { readable: () => [] },
): CapabilityDefinitions => ({
  protocolVersion: 2,
  types: {
    folder: { title: "Folder", description: "A container." },
    entry: { title: "Entry", description: "A contained place.", container: "folder", reader: "entry.read", ...(access ? { access } : {}) },
  },
  events: {
    created: {
      title: "Created",
      description: "Created in a place.",
      version: 1,
      subject: "entry",
      place: "entry",
      schema: z.strictObject({}),
    },
  },
  queries: {
    "entry.read": {
      title: "Read",
      description: "Read with ordinary grants.",
      openWorld: false,
      input: z.strictObject({ id: z.string().describe("Entry ID.") }),
      data: z.strictObject({ secret: z.string() }),
      run: run as never,
    },
  },
});

// #3539: Code binds its registration to the place, never to a container, and asks the place itself.
test("a contained event place derives a container-free reader that runs as each account and fails closed", async () => {
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
  mocks.push(
    spyOn(serviceAccounts, "get").mockResolvedValue({
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
    }),
  );
  let mode: "account" | "nobody" | "broken" = "account";
  const seen: CapabilityExecutionContext[] = [];
  const compiled = compileCapabilities(
    "provider",
    containedPlace(async (input, projected) => {
      expect(input).toEqual({ id: "folder-1" });
      seen.push(projected);
      if (mode === "broken") throw new Error("storage unavailable");
      if (mode === "nobody" || projected.actor.kind === "user")
        return { ok: false, error: { code: "FORBIDDEN", message: "No", status: 403 } };
      return { ok: true, data: { data: { secret: "never leaves the provider" } } };
    }),
  );
  const operation = compiled.queries.get("entry.readable");
  expect(operation?.manifest.appOnly).toBe(true);
  expect(Object.keys(operation!.manifest.inputSchema.properties as object).sort()).toEqual(["id", "principals"]);
  const invoke = (input: Record<string, unknown>) =>
    invokeCompiledCapability({
      compiled,
      kind: "query",
      localId: "entry.readable",
      expectedSchemaHash: operation!.manifest.schemaHash,
      input,
      context,
    }).catch((error: unknown) => ({ ok: false as const, error }));
  const place = { id: "folder-1", principals: [userPrincipal, accountPrincipal] };
  // The account that may read the place is readable; the person who may not read it is left out.
  expect(await invoke(place)).toEqual({ ok: true, data: { data: { readable: [accountPrincipal] } } });
  expect(seen.at(-1)?.actor).toMatchObject({ kind: "service_account", serviceAccount: { kind: "code" }, scopes: ["read"] });
  expect(seen.every((value) => !value.query && !value.idempotencyKey)).toBe(true);
  mode = "nobody";
  expect(await invoke(place)).toEqual({ ok: true, data: { data: { readable: [] } } });
  // An unavailable reader never counts as readable.
  mode = "broken";
  expect((await invoke(place)).ok).toBe(false);
  // A check that names a container is refused rather than answered without it.
  mode = "account";
  const calls = seen.length;
  expect((await invoke({ ...place, container: { type: "provider.folder", id: "parent" } })).ok).toBe(false);
  expect(seen).toHaveLength(calls);
});

test("an explicit hook on a contained place keeps requiring the expected container", () => {
  const compiled = compileCapabilities(
    "provider",
    containedPlace(async () => ({ ok: true, data: { data: { secret: "x" } } }), { readable: () => [] }),
  );
  expect(compiled.manifest.queries.find((query) => query.localId === "entry.readable")?.inputSchema.required).toContain("container");
});
