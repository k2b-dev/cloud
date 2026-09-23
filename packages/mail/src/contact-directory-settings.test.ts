import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  canCreateDirectoryContacts,
  DEFAULT_MAIL_CONTACT_DIRECTORY,
  MAIL_CONTACT_DIRECTORY_DEFAULTS,
  requestContactDirectory,
  resolveMailContactDirectory,
} from "./contact-directory-settings";

const crm = {
  appId: "crm",
  suggest: "customer.suggest",
  resolve: "customer.match",
  read: "",
  listWritableBooks: "",
  create: "",
};

const snapshot = (value: typeof crm) => ({
  mail: {
    contact_directory: {
      app: value.appId,
      suggest: value.suggest,
      resolve: value.resolve,
      read: value.read,
      list_writable_books: value.listWritableBooks,
      create: value.create,
    },
  },
});

const readDirectory = async (settings?: unknown) => {
  const router = new Hono<{ Variables: { settings: unknown } }>();
  if (settings !== undefined)
    router.use(async (c, next) => {
      c.set("settings", settings);
      await next();
    });
  router.get("/", (c) => c.json(requestContactDirectory(c)));
  return (await router.request("/")).json();
};

describe("Mail contact directory settings", () => {
  test("default to the built-in Contacts capabilities without configuration", async () => {
    expect(DEFAULT_MAIL_CONTACT_DIRECTORY).toEqual({
      suggest: { appId: "contacts", capabilityId: "contact.suggest" },
      resolve: { appId: "contacts", capabilityId: "contact.resolve" },
      read: { appId: "contacts", capabilityId: "contact.read" },
      listWritableBooks: { appId: "contacts", capabilityId: "book.list" },
      create: { appId: "contacts", capabilityId: "contact.create" },
    });
    expect(await readDirectory()).toEqual(DEFAULT_MAIL_CONTACT_DIRECTORY);
    expect(await readDirectory(snapshot(MAIL_CONTACT_DIRECTORY_DEFAULTS))).toEqual(DEFAULT_MAIL_CONTACT_DIRECTORY);
  });

  test("resolve every function from the stored mapping and leave unmapped functions empty", async () => {
    expect(await readDirectory(snapshot(crm))).toEqual({
      suggest: { appId: "crm", capabilityId: "customer.suggest" },
      resolve: { appId: "crm", capabilityId: "customer.match" },
      read: null,
      listWritableBooks: null,
      create: null,
    });
  });

  test("never call a malformed app or capability ID", () => {
    expect(resolveMailContactDirectory({ ...crm, appId: "CRM App" }).suggest).toBeNull();
    expect(resolveMailContactDirectory({ ...crm, suggest: "Customer Suggest" }).suggest).toBeNull();
    expect(resolveMailContactDirectory({ ...crm, suggest: " customer.suggest " }).suggest).toEqual({
      appId: "crm",
      capabilityId: "customer.suggest",
    });
  });

  test("offer New contact only when both the book list and create are mapped", () => {
    expect(canCreateDirectoryContacts(DEFAULT_MAIL_CONTACT_DIRECTORY)).toBeTrue();
    expect(canCreateDirectoryContacts(resolveMailContactDirectory(crm))).toBeFalse();
    expect(canCreateDirectoryContacts(resolveMailContactDirectory({ ...crm, listWritableBooks: "book.list" }))).toBeFalse();
    expect(
      canCreateDirectoryContacts(resolveMailContactDirectory({ ...crm, listWritableBooks: "segment.list", create: "customer.create" })),
    ).toBeTrue();
  });
});
