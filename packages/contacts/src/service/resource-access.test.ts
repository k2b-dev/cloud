import { expect, spyOn, test } from "bun:test";
import { serviceAccounts } from "@k2b/cloud/services";
import * as books from "./books";
import { resolveContactsByEmail } from "./contact-lookup";
import * as contacts from "./contacts";

const resourceSubject = {
  type: "service_account" as const,
  serviceAccountId: "11111111-1111-4111-8111-111111111111",
};

test("resource service-account collections fail closed without a valid book binding", async () => {
  const lookup = spyOn(serviceAccounts, "get").mockResolvedValue({
    id: resourceSubject.serviceAccountId,
    name: "Bound key",
    kind: "resource_bound",
    status: "active",
    delegatedUserId: null,
    appId: "contacts",
    resourceType: "contact_book",
    resourceId: "22222222-2222-4222-8222-222222222222",
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  try {
    expect(await books.list({ subject: resourceSubject })).toEqual([]);
    expect(await books.findReadableByName({ subject: resourceSubject, name: "Customers", limit: 5 })).toEqual([]);
    expect(await books.listPage({ subject: resourceSubject, pagination: { page: 2, perPage: 10 } })).toEqual({
      items: [],
      page: 2,
      perPage: 10,
      total: 0,
      hasNext: false,
    });
    expect(await contacts.search({ subject: resourceSubject, pagination: { page: 3, perPage: 20 } })).toEqual({
      items: [],
      page: 3,
      perPage: 20,
      total: 0,
      hasNext: false,
    });
    expect(
      await resolveContactsByEmail({ subject: resourceSubject, boundBookId: null, input: { emails: ["ada@example.test"], limit: 5 } }),
    ).toEqual({ ok: true, data: { items: [], matchedEmails: [], nextCursor: null } });
  } finally {
    lookup.mockRestore();
  }
});
