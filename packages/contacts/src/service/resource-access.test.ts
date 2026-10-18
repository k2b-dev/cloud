import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { err, fail } from "@k2b/stdlib";
import type { BookCaller } from ".";
import { contactsService } from ".";
import * as access from "./access";
import * as apiKeys from "./api-keys";
import * as books from "./books";
import * as tags from "./tags";

afterEach(() => mock.restore());

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
  expect(await contactsService.tag.listForBooks({ ...caller, bookIds: ["22222222-2222-4222-8222-222222222222"] })).toEqual(denied);
  expect(await contactsService.book.listPage({ ...caller, filter: { minimumPermission: "write" } })).toEqual(denied);
  expect(await contactsService.book.findReadableByName({ ...caller, name: "Customers", limit: 5 })).toEqual(denied);
  expect(await contactsService.contact.search({ ...caller, pagination: { page: 3, perPage: 20 } })).toEqual(denied);
  expect(await contactsService.lookup.resolveContactsByEmail({ ...caller, input: { emails: ["ada@example.test"], limit: 5 } })).toEqual(
    denied,
  );
});

test("tag collection uses one readable-book lookup and never checks requested books individually", async () => {
  const bookId = "22222222-2222-4222-8222-222222222222";
  const otherBookId = "33333333-3333-4333-8333-333333333333";
  if (caller.actor.kind !== "service_account") throw new Error("Expected service account");
  const bound = { ...caller, actor: { ...caller.actor, serviceAccount: { ...caller.actor.serviceAccount, resourceId: bookId } } };
  const list = spyOn(books, "list").mockResolvedValue([
    { id: bookId, name: "Readable", description: null, createdAt: null, updatedAt: null },
  ]);
  const permission = spyOn(access, "getActorBookPermission");
  const listTags = spyOn(tags, "listForBooks").mockResolvedValue([]);
  expect(await contactsService.tag.listForBooks({ ...bound, bookIds: [otherBookId, bookId] })).toEqual({ ok: true, data: [] });
  expect(list).toHaveBeenCalledTimes(1);
  expect(list).toHaveBeenCalledWith({ subject: bound.accessSubject, boundBookId: bookId });
  expect(listTags).toHaveBeenCalledWith({ bookIds: [bookId] });
  expect(permission).not.toHaveBeenCalled();
});

test("settings context authorizes once before loading access, keys, and tags", async () => {
  const bookId = "22222222-2222-4222-8222-222222222222";
  const book = { id: bookId, name: "Settings", description: null, createdAt: null, updatedAt: null };
  const get = spyOn(books, "get").mockResolvedValue(book);
  const permission = spyOn(access, "getActorBookPermission").mockResolvedValue("none");
  const entries = spyOn(books.access, "list").mockResolvedValue({ items: [], page: 1, perPage: 100, total: 0, hasNext: false });
  const keys = spyOn(apiKeys, "list").mockResolvedValue([]);
  const listTags = spyOn(tags, "list").mockResolvedValue([]);
  expect(await contactsService.book.settingsContext({ ...caller, id: bookId })).toEqual(fail(err.forbidden("Access denied")));
  for (const load of [entries, keys, listTags]) expect(load).not.toHaveBeenCalled();
  get.mockClear();
  permission.mockClear();
  permission.mockResolvedValue("admin");
  expect(await contactsService.book.settingsContext({ ...caller, id: bookId })).toEqual({
    ok: true,
    data: { book, accessEntries: [], apiKeys: [], tags: [] },
  });
  expect(get).toHaveBeenCalledTimes(1);
  expect(permission).toHaveBeenCalledTimes(1);
  for (const load of [entries, keys, listTags]) expect(load).toHaveBeenCalledWith({ bookId });
});
