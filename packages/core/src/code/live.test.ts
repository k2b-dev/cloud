import { afterEach, expect, spyOn, test } from "bun:test";
import { UserSchema } from "@k2b/cloud/contracts";
import type { LiveViewer } from "@k2b/cloud/events";
import * as server from "@k2b/cloud/server";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { type CodeContext, CodeOwnerUnavailableError, codeLiveReaders, type readCodeOwner } from "./access";
import { type Code, CodeSchema } from "./contracts";

useUnitClients();
const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const code: Code = CodeSchema.parse({
  id: "c_test",
  owner: { kind: "person", userId: owner },
  title: "Fixture",
  state: "draft",
  serviceAccountId: null,
  serviceAccountHandle: null,
  activeVersionId: null,
  pauseReason: null,
  pauseRows: [],
  pausePolicyRevision: null,
  createdBy: owner,
  createdAt: "2026-11-14T12:00:00.000Z",
});
const viewer = (id: string, admin = false): LiveViewer => ({
  id: `user:${id}`,
  actor: {
    kind: "user",
    user: UserSchema.parse({
      id,
      uid: id,
      roles: admin ? ["admin"] : ["user"],
      provider: "local",
      profile: "user",
      displayName: "Fixture",
      givenname: "Live",
      sn: "Fixture",
      mail: null,
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    }),
  },
  accessSubject: { type: "user", userId: id },
  scopes: [],
});
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

test("admission retains Code's person and credential guards; owners and administrators need no grant lookup", async () => {
  const grant = spyOn(server, "getEffectivePermissions").mockResolvedValue([]);
  spies.push(grant);
  const own = viewer(owner);
  const admin = viewer(other, true);
  const emptyToken = { ...own, id: `${own.id}:scopes=` };
  expect(await codeLiveReaders(code, [own, admin, emptyToken])).toEqual(new Set([own.id, admin.id]));
  expect(grant.mock.calls[0]?.[0].subjects).toEqual([]);
});

test("shared readers are checked together and an unshared non-administrator is denied", async () => {
  const reader = viewer(other);
  const scoped = { ...viewer(owner), id: `user:${owner}:scopes=read`, scopes: ["read"] };
  const grant = spyOn(server, "getEffectivePermissions").mockResolvedValue(["read", "none"]);
  spies.push(grant);
  const resource: Code = { ...code, owner: { kind: "resource", ref: { type: "example.place", id: "one" } } };
  expect(await codeLiveReaders(resource, [reader, scoped], async () => ({ title: "Owner", admin: false }))).toEqual(new Set([reader.id]));
  expect(grant).toHaveBeenCalledTimes(1);
  expect(grant.mock.calls[0]?.[0].subjects).toEqual([reader.accessSubject, scoped.accessSubject]);
});

test("resource Code admits owner administrators, Cloud administrators and share readers, but not other viewers", async () => {
  const ownerAdmin = viewer(owner);
  const nonAdmin = viewer(other);
  const cloudAdmin = viewer("33333333-3333-4333-8333-333333333333", true);
  const shareReader = viewer("44444444-4444-4444-8444-444444444444");
  const scoped = { ...ownerAdmin, id: `${ownerAdmin.id}:scopes=`, scopes: [] };
  const grant = spyOn(server, "getEffectivePermissions").mockResolvedValue(["none", "none", "read"]);
  spies.push(grant);
  const contexts: CodeContext[] = [];
  const readOwner: typeof readCodeOwner = async (_owner, context) => {
    contexts.push(context);
    return { title: "Mailbox", admin: context.authority.accessSubject.type === "user" && context.authority.accessSubject.userId === owner };
  };
  const resource: Code = { ...code, owner: { kind: "resource", ref: { type: "mail.mailbox", id: "one" } } };
  expect(await codeLiveReaders(resource, [ownerAdmin, nonAdmin, cloudAdmin, shareReader, scoped], readOwner)).toEqual(
    new Set([ownerAdmin.id, cloudAdmin.id, shareReader.id]),
  );
  expect(contexts.map(({ authority }) => authority)).toEqual(
    [ownerAdmin, nonAdmin].map((who) => ({ actor: who.actor, accessSubject: who.accessSubject, scopes: [], credentialKind: "session" })),
  );
});

test("an unavailable owner retains existing readers and Cloud administrators, but grants no new access", async () => {
  const unshared = viewer(owner);
  const shared = viewer(other);
  const admin = viewer("33333333-3333-4333-8333-333333333333", true);
  const grant = spyOn(server, "getEffectivePermissions").mockResolvedValue(["none", "read"]);
  spies.push(grant);
  const resource: Code = { ...code, owner: { kind: "resource", ref: { type: "mail.mailbox", id: "one" } } };
  const readOwner: typeof readCodeOwner = async () => {
    throw new CodeOwnerUnavailableError("offline");
  };
  expect(await codeLiveReaders(resource, [unshared, shared, admin], readOwner)).toEqual(new Set([shared.id, admin.id]));
  await expect(
    codeLiveReaders(resource, [unshared], async () => {
      throw new Error("unexpected owner failure");
    }),
  ).rejects.toThrow("unexpected owner failure");
});

test("owner checks are bounded to eight concurrent calls per authorization batch", async () => {
  const viewers = Array.from({ length: 20 }, (_, index) => viewer(`00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`));
  const grant = spyOn(server, "getEffectivePermissions").mockResolvedValue(viewers.map(() => "none"));
  spies.push(grant);
  const resource: Code = { ...code, owner: { kind: "resource", ref: { type: "mail.mailbox", id: "one" } } };
  let inFlight = 0;
  let peak = 0;
  let checked = 0;
  const readOwner: typeof readCodeOwner = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await Promise.resolve();
    checked++;
    inFlight--;
    return { title: "Mailbox", admin: true };
  };
  expect(await codeLiveReaders(resource, viewers, readOwner)).toEqual(new Set(viewers.map((who) => who.id)));
  expect(checked).toBe(viewers.length);
  expect(peak).toBe(8);
});

test("delegated API keys keep legacy empty scopes; OAuth credentials do not gain that exception", async () => {
  const grant = spyOn(server, "getEffectivePermissions").mockResolvedValue([]);
  spies.push(grant);
  const own = viewer(owner);
  if (own.actor.kind !== "user") throw new Error("Expected user fixture");
  const account: LiveViewer = {
    ...own,
    id: `${own.id}:scopes=`,
    actor: {
      kind: "service_account",
      delegatedUser: own.actor.user,
      scopes: [],
      credentialId: other,
      serviceAccount: {
        id: other,
        name: "Fixture",
        kind: "user_delegated",
        status: "active",
        delegatedUserId: owner,
        appId: null,
        resourceType: null,
        resourceId: null,
        createdBy: owner,
        createdAt: "2026-11-14T12:00:00.000Z",
      },
    },
  };
  const oauth = { ...account, actor: { ...account.actor, oauthClientId: "client" } };
  expect(await codeLiveReaders(code, [account])).toEqual(new Set([account.id]));
  expect(await codeLiveReaders(code, [oauth])).toEqual(new Set());
});
