import { expect, test } from "bun:test";
import { groupsHref, groupsListState, groupsQuery, legacyGroupsHref, parseGroupsAddress } from "./query";

const query = groupsQuery("de", "member");

test("the scope is mandatory: at the person's default it stays out of the address", () => {
  const plain = parseGroupsAddress(query, new URLSearchParams(""));
  expect(plain.state.filters.scope).toBe("member");
  expect(groupsHref(query, plain.state)).toBe("/app/accounts/groups");
  const managed = parseGroupsAddress(query, new URLSearchParams("scope=managed&provider=ipa&q=fin&page=2"));
  expect(managed.issues).toEqual([]);
  expect(groupsHref(query, managed.state, managed.page)).toBe("/app/accounts/groups?scope=managed&provider=ipa&q=fin&page=2");
  expect(groupsListState(managed.state, managed.page)).toEqual({ search: "fin", page: 2, provider: "ipa", scope: "managed" });
});

test("addresses from before v2 lead to the same list; the former personal-groups filter falls away", () => {
  expect(legacyGroupsHref(query, new URLSearchParams("personal=1&scope=all&search=Design"))).toBe(
    "/app/accounts/groups?scope=all&q=Design",
  );
  expect(legacyGroupsHref(query, new URLSearchParams("search=fin&page=2&scope=managed"))).toBe(
    "/app/accounts/groups?scope=managed&q=fin&page=2",
  );
  expect(legacyGroupsHref(query, new URLSearchParams("q=fin"))).toBeNull();
});

test("a too long search is dropped and named", () => {
  const address = parseGroupsAddress(query, new URLSearchParams({ q: "x".repeat(201) }));
  expect(address.state.search).toBeUndefined();
  expect(address.issues.map((issue) => issue.param)).toEqual(["q"]);
});
