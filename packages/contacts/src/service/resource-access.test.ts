import { expect, test } from "bun:test";
import { err, fail } from "@k2b/stdlib";
import type { BookCaller } from ".";
import { contactsService } from ".";

const caller: BookCaller = {
  actor: {
    kind: "service_account",
    serviceAccount: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Bound key",
      kind: "resource_bound",
      status: "active",
      delegatedUserId: null,
      appId: "contacts",
      resourceType: "contact_book",
      resourceId: null,
      createdBy: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    delegatedUser: null,
    scopes: ["read"],
  },
  accessSubject: { type: "service_account", serviceAccountId: "11111111-1111-4111-8111-111111111111" },
};

test("resource service-account collections fail closed without a valid book binding", async () => {
  const denied = fail(err.forbidden("Access denied"));
  expect(await contactsService.book.list(caller)).toEqual(denied);
  expect(await contactsService.book.listPage({ ...caller, pagination: { page: 2, perPage: 10 } })).toEqual(denied);
  expect(await contactsService.book.readableIds(caller)).toEqual(denied);
  expect(await contactsService.book.findReadableByName({ ...caller, name: "Customers", limit: 5 })).toEqual(denied);
  expect(await contactsService.contact.search({ ...caller, pagination: { page: 3, perPage: 20 } })).toEqual(denied);
  expect(await contactsService.lookup.resolveContactsByEmail({ ...caller, input: { emails: ["ada@example.test"], limit: 5 } })).toEqual(
    denied,
  );
});
