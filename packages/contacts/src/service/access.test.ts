import { describe, expect, mock, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import type { PermissionLevel, RequestActor } from "@k2b/cloud/server";
import type { ServiceAccount } from "@k2b/cloud/services";
import type { SQL } from "bun";
import { getActorBookPermission, isContactsAdministrator, readableBookScope } from "./access";

const userId = "11111111-1111-4111-8111-111111111111";
const bookId = "22222222-2222-4222-8222-222222222222";
const otherBookId = "33333333-3333-4333-8333-333333333333";
const serviceAccountId = "44444444-4444-4444-8444-444444444444";
const accessRows = [{ access_id: "55555555-5555-4555-8555-555555555555" }];
const user: User = {
  id: userId,
  uid: "contacts-user",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Contacts",
  sn: "User",
  displayName: "Contacts User",
  mail: "contacts@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
const admin: User = { ...user, roles: ["user", "admin"] };

const accountActor = (kind: ServiceAccount["kind"], delegatedUser: User | null = null): RequestActor => ({
  kind: "service_account",
  serviceAccount: {
    id: serviceAccountId,
    name: "Contacts key",
    kind,
    status: "active",
    delegatedUserId: delegatedUser?.id ?? null,
    appId: kind === "resource_bound" ? "contacts" : null,
    resourceType: kind === "resource_bound" ? "contact_book" : null,
    resourceId: kind === "resource_bound" ? bookId : null,
    createdBy: null,
    createdAt: "2026-08-02T08:00:00.000Z",
  },
  delegatedUser,
  scopes: ["read"],
});

const fixture = (rows: { access_id: string }[], permission: PermissionLevel) => {
  const query = mock(async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("FROM contacts.book_access")) return rows;
    if (text.includes("FROM auth.access")) return [{ permission }];
    throw new Error(`Unexpected query: ${text}`);
  });
  return { db: query as unknown as SQL, query };
};

describe("getActorBookPermission", () => {
  test("a resource-bound Contacts key has no permission on another book without querying grants", async () => {
    const { db, query } = fixture(accessRows, "admin");
    expect(
      await getActorBookPermission(
        {
          bookId: otherBookId,
          actor: accountActor("resource_bound"),
          accessSubject: { type: "service_account", serviceAccountId },
        },
        db,
      ),
    ).toBe("none");
    expect(query).not.toHaveBeenCalled();
  });

  test("a resource-bound Contacts key caps its own book's admin grant at its read scope", async () => {
    const { db, query } = fixture(accessRows, "admin");
    expect(
      await getActorBookPermission(
        { bookId, actor: accountActor("resource_bound"), accessSubject: { type: "service_account", serviceAccountId } },
        db,
      ),
    ).toBe("read");
    expect(query).toHaveBeenCalledTimes(2);
  });

  test("an agent's write grant is capped at its read scope", async () => {
    const { db } = fixture(accessRows, "write");
    expect(
      await getActorBookPermission(
        { bookId, actor: accountActor("agent"), accessSubject: { type: "service_account", serviceAccountId } },
        db,
      ),
    ).toBe("read");
  });

  test("a user-delegated account keeps its delegated user's admin grant despite its read scope", async () => {
    const { db } = fixture(accessRows, "admin");
    expect(
      await getActorBookPermission({ bookId, actor: accountActor("user_delegated", user), accessSubject: { type: "user", userId } }, db),
    ).toBe("admin");
  });

  test("a Cloud admin without book access has no permission", async () => {
    const { db, query } = fixture([], "admin");
    expect(
      await getActorBookPermission({ bookId, actor: { kind: "user", user: admin }, accessSubject: { type: "user", userId } }, db),
    ).toBe("none");
    expect(query).toHaveBeenCalledTimes(1);
  });

  test("a plain user keeps their write grant", async () => {
    const { db } = fixture(accessRows, "write");
    expect(await getActorBookPermission({ bookId, actor: { kind: "user", user }, accessSubject: { type: "user", userId } }, db)).toBe(
      "write",
    );
  });
});

test("Contacts administration requires an admin user, directly or delegated", () => {
  expect(isContactsAdministrator({ kind: "user", user: admin })).toBe(true);
  expect(isContactsAdministrator(accountActor("user_delegated", admin))).toBe(true);
  expect(isContactsAdministrator(accountActor("agent"))).toBe(false);
  expect(isContactsAdministrator({ kind: "user", user })).toBe(false);
});

describe("readableBookScope", () => {
  test("user subjects read through grants, including delegated credentials without read scopes", () => {
    const accessSubject = { type: "user" as const, userId };
    expect(readableBookScope({ actor: { kind: "user", user }, accessSubject })).toEqual({ ok: true, data: { boundBookId: null } });
    const actor = accountActor("user_delegated", user);
    if (actor.kind !== "service_account") throw new Error("Expected service account fixture");
    expect(readableBookScope({ actor: { ...actor, scopes: [] }, accessSubject })).toEqual({ ok: true, data: { boundBookId: null } });
  });

  test.each(["agent", "standalone"] as const)("%s needs the matching subject and a readable scope", (kind) => {
    const actor = accountActor(kind);
    if (actor.kind !== "service_account") throw new Error("Expected service account fixture");
    const accessSubject = { type: "service_account" as const, serviceAccountId };
    for (const scope of ["read", "write", "admin"]) {
      expect(readableBookScope({ actor: { ...actor, scopes: [scope] }, accessSubject })).toEqual({ ok: true, data: { boundBookId: null } });
    }
    expect(readableBookScope({ actor: { ...actor, scopes: ["openid"] }, accessSubject })).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", message: "Access denied" },
    });
    expect(readableBookScope({ actor, accessSubject: { type: "service_account", serviceAccountId: userId } })).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
  });

  test("resource-bound scopes need an exact Contacts binding, UUID, and read scope", () => {
    const actor = accountActor("resource_bound");
    if (actor.kind !== "service_account") throw new Error("Expected service account fixture");
    const accessSubject = { type: "service_account" as const, serviceAccountId };
    expect(readableBookScope({ actor, accessSubject })).toEqual({ ok: true, data: { boundBookId: bookId } });
    for (const binding of [{ appId: "other" }, { resourceType: "other" }, { resourceId: null }, { resourceId: "Book01" }]) {
      expect(
        readableBookScope({ actor: { ...actor, serviceAccount: { ...actor.serviceAccount, ...binding } }, accessSubject }),
      ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    }
    expect(readableBookScope({ actor: { ...actor, scopes: [] }, accessSubject })).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
  });

  test("a service-account subject cannot borrow a user actor or a delegated account binding", () => {
    const accessSubject = { type: "service_account" as const, serviceAccountId };
    expect(readableBookScope({ actor: { kind: "user", user }, accessSubject })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(readableBookScope({ actor: accountActor("user_delegated", user), accessSubject })).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
  });
});
