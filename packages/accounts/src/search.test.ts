import { expect, test } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { UniversalSearchDataSchema, type User } from "@k2b/cloud/contracts";
import { accountsCapabilities } from "./capabilities";
import { searchAccounts } from "./search";

const user: User = {
  id: "user",
  uid: "viewer",
  provider: "local",
  profile: "user",
  roles: ["user"],
  givenname: "Test",
  sn: "User",
  displayName: "Test",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
test("account projection preserves admin-only targets and the Core actor", async () => {
  const roleSets: User["roles"][] = [["user"], ["user", "admin"]];
  for (const roles of roleSets) {
    const result = await searchAccounts(
      { query: "Ada", tags: [], limit: 7 },
      { actor: { kind: "user", user: { ...user, roles } }, locale: "en" },
      async (request) => {
        expect(request.actor).toMatchObject({ userId: user.id, roles });
        expect(request.kinds).toEqual(roles.includes("admin") ? ["user", "group", "service_account"] : ["group"]);
        expect(request.pagination).toEqual({ page: 1, perPage: 7 });
        expect(request.search).toBe("Ada");
        return { items: [], page: 1, perPage: 7, total: 0, hasNext: false };
      },
    );
    expect(result.ok).toBe(true);
  }
});
test("guests and invalid resource scopes never query the directory", async () => {
  let calls = 0;
  const list = async () => {
    calls++;
    return { items: [], page: 1, perPage: 1, total: 0, hasNext: false };
  };
  const input = { query: "", tags: [], limit: 1 };
  expect(
    (await searchAccounts(input, { actor: { kind: "user", user: { ...user, roles: ["guest"], profile: "guest" } }, locale: "de" }, list))
      .ok,
  ).toBe(false);
  expect(
    (
      await searchAccounts(
        { ...input, scope: { type: "accounts.group", id: "group" } },
        { actor: { kind: "user", user }, locale: "en" },
        list,
      )
    ).ok,
  ).toBe(false);
  expect(calls).toBe(0);
  expect(() => compileCapabilityManifest("accounts", accountsCapabilities)).not.toThrow();
});

test("directory descriptions stay inside the shared search contract", async () => {
  const result = await searchAccounts(
    { query: "team", tags: [], limit: 10 },
    { actor: { kind: "user", user }, locale: "en" },
    async () => ({
      items: [
        {
          kind: "group",
          group: {
            id: "12345678-1234-4234-8234-123456789abc",
            provider: "local",
            name: "Team",
            description: "x".repeat(4000),
            gidnumber: null,
            personalOwner: null,
          },
        },
      ],
      total: 1,
      page: 1,
      perPage: 10,
      hasNext: false,
    }),
  );
  if (!result.ok) throw new Error("Expected result");
  expect(UniversalSearchDataSchema.safeParse(result.data.data).success).toBe(true);
  expect(result.data.data[0]?.preview).toHaveLength(2000);
  expect(result.data.data[0]?.links[0]?.href).toBe("/app/accounts/groups/12345678-1234-4234-8234-123456789abc");
});
