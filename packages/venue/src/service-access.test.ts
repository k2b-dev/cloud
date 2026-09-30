import { expect, spyOn, test } from "bun:test";
import { serviceAccounts } from "@k2b/cloud/services";
import { venueService } from "./service";

test("resource service-account venue lists fail closed without a valid binding", async () => {
  const subject = { type: "service_account" as const, serviceAccountId: "11111111-1111-4111-8111-111111111111" };
  const lookup = spyOn(serviceAccounts, "get").mockResolvedValue({
    id: subject.serviceAccountId,
    name: "Bound key",
    kind: "resource_bound",
    status: "active",
    delegatedUserId: null,
    appId: "venue",
    resourceType: "venue",
    resourceId: "22222222-2222-4222-8222-222222222222",
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  try {
    expect(await venueService.venues.list({ subject, serviceAccountScopes: ["read"] })).toEqual([]);
    expect(await venueService.venues.discover({ subject, serviceAccountScopes: ["read"] })).toEqual([]);
    expect(await venueService.venues.list({ subject, serviceAccountResourceId: "not-a-venue", serviceAccountScopes: ["read"] })).toEqual(
      [],
    );
  } finally {
    lookup.mockRestore();
  }
});
