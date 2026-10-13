import { expect, spyOn, test } from "bun:test";
import { serviceAccounts } from "@k2b/cloud/services";
import { isBm25CapabilityError, searchAcross, splitPrefixQuery } from "./search";

test.each([
  ["", { rest: "", prefix: null }],
  ["Bespr", { rest: "", prefix: "Bespr:*" }],
  ["Über", { rest: "", prefix: "Über:*" }],
  ["U\u0308ber", { rest: "", prefix: "Über:*" }],
  ["team Bespr", { rest: "team", prefix: "Bespr:*" }],
  ["team\t\nBespr", { rest: "team", prefix: "Bespr:*" }],
  ["a:*", { rest: "", prefix: "a:*" }],
  ["(", { rest: "(", prefix: null }],
  ["!", { rest: "!", prefix: null }],
  ["&|", { rest: "&|", prefix: null }],
  ['"', { rest: '"', prefix: null }],
  ['""', { rest: '""', prefix: null }],
  ["-draft", { rest: "-draft", prefix: null }],
  ['"rollback plan"', { rest: '"rollback plan"', prefix: null }],
  ['"rollback plan', { rest: '"rollback plan', prefix: null }],
  ['"rollback plan" draft', { rest: '"rollback plan"', prefix: "draft:*" }],
  ["e-mail", { rest: "", prefix: "email:*" }],
  ["deployment or Bespr", { rest: "deployment or Bespr", prefix: null }],
  ["deployment OR Bespr", { rest: "deployment OR Bespr", prefix: null }],
  ["Woche 41", { rest: "Woche", prefix: "41:*" }],
])("splits the last prefix token in %j", (query, expected) => {
  expect(splitPrefixQuery(query)).toEqual(expected);
});

test("BM25 fallback accepts only capability errors", () => {
  expect(isBm25CapabilityError({ code: "42883" })).toBe(true);
  expect(isBm25CapabilityError({ code: "0A000" })).toBe(true);
  expect(isBm25CapabilityError({ code: "23505" })).toBe(false);
  expect(isBm25CapabilityError(new Error("connection failed"))).toBe(false);
});

test("resource searches fail closed before querying outside their notebook binding", async () => {
  const lookup = spyOn(serviceAccounts, "get").mockResolvedValue({
    id: "11111111-1111-4111-8111-111111111111",
    name: "Bound key",
    kind: "resource_bound",
    status: "active",
    delegatedUserId: null,
    appId: "notebooks",
    resourceType: "notebook",
    resourceId: "22222222-2222-4222-8222-222222222222",
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const common = {
    userId: null,
    serviceAccountId: "11111111-1111-4111-8111-111111111111",
    filters: {},
    pagination: { page: 1, perPage: 20, offset: 0 },
  };

  expect(await searchAcross(common)).toEqual({ hits: [], total: 0 });
  expect(
    await searchAcross({
      ...common,
      boundNotebookId: "22222222-2222-4222-8222-222222222222",
      notebookId: "33333333-3333-4333-8333-333333333333",
    }),
  ).toEqual({ hits: [], total: 0 });
  lookup.mockRestore();
});
