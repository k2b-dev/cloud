import { expect, spyOn, test } from "bun:test";
import { serviceAccounts } from "@k2b/cloud/services";
import { isBm25CapabilityError, searchAcross } from "./search";

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
