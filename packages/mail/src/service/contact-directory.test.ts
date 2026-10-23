import { afterAll, describe, expect, test } from "bun:test";
import type { CapabilityCatalogApp } from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import {
  type CapabilityDefinitions,
  type CapabilityInvocationResult,
  ContactDirectoryBookListInputSchema,
  ContactDirectoryContactSchema,
  ContactDirectoryCreateInputSchema,
  ContactDirectoryMatchSchema,
  ContactDirectoryReadInputSchema,
  ContactDirectoryResolveInputSchema,
  ContactDirectorySuggestInputSchema,
  ContactDirectorySuggestionSchema,
  defineCapabilities,
  type User,
} from "@k2b/cloud/contracts";
import { SQL } from "bun";
import { z } from "zod";
import { MAIL_CONTACT_DIRECTORY_SETTING_KEYS, type MailContactDirectoryConfig } from "../contact-directory-settings";
import type { MailRequestContext } from "./auth";
import {
  type ContactDirectoryDependencies,
  contactDirectoryIssues,
  loadContactDirectoryAdmin,
  saveContactDirectory,
} from "./contact-directory";

const run = (): CapabilityInvocationResult<never> => ({
  ok: false,
  error: { code: "INTERNAL", message: "Not invoked in this test.", status: 500 },
});

// A third-party customer app: its own IDs and extra fields, the same contract shape.
const CustomerId = z.uuid();
const customer = { contactId: CustomerId, bookId: z.literal("customers"), customerNumber: z.string() };
const crmCapabilities = (overrides: Partial<Record<"suggestData", z.ZodType>> = {}): CapabilityDefinitions =>
  defineCapabilities({
    protocolVersion: 2,
    queries: {
      "customer.suggest": {
        title: "Suggest customers",
        description: "Suggest customers with an email address.",
        input: ContactDirectorySuggestInputSchema,
        data: overrides.suggestData ?? z.array(ContactDirectorySuggestionSchema.extend(customer).strict()).max(10),
        openWorld: false,
        run,
      },
      "customer.match": {
        title: "Match customers",
        description: "Match customers by exact email address.",
        input: ContactDirectoryResolveInputSchema,
        data: z
          .object({
            items: z.array(ContactDirectoryMatchSchema.extend(customer).strict()).max(50),
            matchedEmails: z.array(z.email().max(320)).max(100),
          })
          .strict(),
        openWorld: false,
        run,
      },
      "customer.read": {
        title: "Read customer",
        description: "Read one customer.",
        input: ContactDirectoryReadInputSchema,
        data: ContactDirectoryContactSchema.extend({ id: CustomerId, bookId: z.literal("customers") }).strict(),
        openWorld: false,
        run,
      },
      "customer.search": {
        title: "Search customers",
        description: "Search customers by any field.",
        input: z.object({ text: z.string().describe("Search text.") }).strict(),
        data: z.array(z.object({ id: CustomerId, name: z.string() }).strict()).max(50),
        openWorld: false,
        run,
      },
      "segment.list": {
        title: "List segments",
        description: "List customer segments the caller can write.",
        input: ContactDirectoryBookListInputSchema,
        data: z
          .array(z.object({ id: z.string().min(1).max(40), name: z.string().min(1), description: z.string().nullable() }).strict())
          .max(100),
        openWorld: false,
        run,
      },
    },
    actions: {
      "customer.create": {
        title: "Create customer",
        description: "Create one customer.",
        input: ContactDirectoryCreateInputSchema,
        data: z.object({ contact: ContactDirectoryContactSchema.extend({ id: CustomerId }).strict() }).strict(),
        destructive: false,
        openWorld: false,
        idempotency: "required",
        run,
      },
    },
  });

const catalogApp = (definitions: CapabilityDefinitions = crmCapabilities()): CapabilityCatalogApp => ({
  appId: "crm",
  appName: "Customers",
  appIcon: "ti ti-users",
  appDescription: "Customer management.",
  manifest: compileCapabilityManifest("crm", definitions),
});

const crmConfig: MailContactDirectoryConfig = {
  appId: "crm",
  suggest: "customer.suggest",
  resolve: "customer.match",
  read: "customer.read",
  listWritableBooks: "segment.list",
  create: "customer.create",
};

const admin = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "mail-admin",
  roles: ["admin", "user"],
  provider: "local",
  profile: "user",
  givenname: "Mail",
  sn: "Admin",
  displayName: "Mail Admin",
  mail: "mail-admin@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;
const context: MailRequestContext = {
  actor: { kind: "user", user: admin },
  accessSubject: { type: "user", userId: admin.id },
  requestId: null,
};

const client = new SQL("postgres://localhost/unused_test");
let lockQueries = 0;
const tx = new Proxy(client, {
  apply(_target, _receiver, [strings]) {
    if (!strings.join("?").includes("pg_advisory_xact_lock")) throw new Error("Expected mapping transaction lock");
    lockQueries++;
    return Promise.resolve([]);
  },
});
afterAll(() => client.close());

const dependencies = (overrides: Partial<ContactDirectoryDependencies> = {}) => {
  const writes: Array<[string, string]> = [];
  const deps: ContactDirectoryDependencies = {
    listCatalog: async () => ({ ok: true, data: { protocolVersion: 2, apps: [catalogApp()], page: { hasMore: false } } }),
    getCatalogApp: async (appId) => ({ ok: true, data: appId === "crm" ? catalogApp() : null }),
    isAdmin: async () => true,
    readSetting: async (key) => ({
      value: new Map(
        Object.entries(MAIL_CONTACT_DIRECTORY_SETTING_KEYS).map(([field, key]) => [
          key,
          Object.entries(crmConfig).find(([name]) => name === field)![1],
        ]),
      ).get(key)!,
      stored: "readable",
    }),
    transaction: async (write) => write(tx),
    invalidateSettings: async () => {},
    writeSetting: async (key, value) => {
      writes.push([key, value]);
    },
    ...overrides,
  };
  return { deps, writes };
};

describe("Mail contact directory administration", () => {
  test("offers only capabilities whose published schemas match each function", async () => {
    const { deps } = dependencies();
    const view = await loadContactDirectoryAdmin(context, crmConfig, "en", deps);
    expect(view.ok).toBeTrue();
    if (!view.ok) return;
    expect(view.data.issues).toEqual([]);
    expect(view.data.apps).toEqual([
      {
        appId: "crm",
        appName: "Customers",
        appIcon: "ti ti-users",
        capabilities: {
          suggest: [{ id: "customer.suggest", title: "Suggest customers" }],
          resolve: [{ id: "customer.match", title: "Match customers" }],
          read: [{ id: "customer.read", title: "Read customer" }],
          listWritableBooks: [{ id: "segment.list", title: "List segments" }],
          create: [{ id: "customer.create", title: "Create customer" }],
        },
      },
    ]);
  });

  test("stores a compatible third-party mapping through the settings seam", async () => {
    const previousLocks = lockQueries;
    let inTransaction = false;
    let committed = false;
    const { deps, writes } = dependencies({
      transaction: async (write) => {
        inTransaction = true;
        try {
          return await write(tx);
        } finally {
          inTransaction = false;
          committed = true;
        }
      },
      invalidateSettings: async () => {
        expect(committed).toBe(true);
      },
    });
    const originalRead = deps.readSetting;
    deps.readSetting = async (key, currentTx) => {
      expect(inTransaction).toBe(true);
      expect(lockQueries).toBe(previousLocks + 1);
      expect(currentTx).toBe(tx);
      return originalRead(key, currentTx);
    };
    const originalCatalog = deps.getCatalogApp;
    deps.getCatalogApp = async (...args) => {
      expect(inTransaction).toBe(true);
      return originalCatalog(...args);
    };
    const originalWrite = deps.writeSetting;
    deps.writeSetting = async (key, value, options, currentTx) => {
      expect(inTransaction).toBe(true);
      expect(currentTx).toBe(tx);
      return originalWrite(key, value, options, currentTx);
    };
    expect(await saveContactDirectory(context, { ...crmConfig, read: "", suggest: " customer.suggest " }, "en", deps)).toEqual({
      ok: true,
      config: { ...crmConfig, read: "" },
    });
    expect(writes).toEqual([
      ["mail.contact_directory.app", "crm"],
      ["mail.contact_directory.suggest", "customer.suggest"],
      ["mail.contact_directory.resolve", "customer.match"],
      ["mail.contact_directory.read", ""],
      ["mail.contact_directory.list_writable_books", "segment.list"],
      ["mail.contact_directory.create", "customer.create"],
    ]);
  });

  test("rejects an incompatible schema with a localized field-level issue and stores nothing", async () => {
    const incompatible = crmCapabilities({
      suggestData: z.array(ContactDirectorySuggestionSchema.extend({ ...customer, displayName: z.string().nullable() }).strict()).max(10),
    });
    const { deps, writes } = dependencies({ getCatalogApp: async () => ({ ok: true, data: catalogApp(incompatible) }) });
    expect(await saveContactDirectory(context, crmConfig, "de", deps)).toEqual({
      ok: false,
      status: 400,
      issues: [
        {
          field: "suggest",
          code: "data_mismatch",
          message: "„Empfänger vorschlagen“: customer.suggest kann bei $[].displayName ein Ergebnis liefern, das nicht zum Vertrag passt.",
        },
      ],
    });
    expect(writes).toEqual([]);
  });

  test("explains missing, wrong, and incomplete mappings per field", () => {
    const app = catalogApp();
    expect(contactDirectoryIssues({ ...crmConfig, appId: "gone" }, null, "en")).toEqual([
      {
        field: "appId",
        code: "app_missing",
        message: "gone is not installed or publishes no capabilities. Choose another app or start it first.",
      },
    ]);
    expect(
      contactDirectoryIssues({ ...crmConfig, suggest: "", resolve: "customer.search", read: "customer.create", create: "" }, app, "en").map(
        (issue) => [issue.field, issue.code],
      ),
    ).toEqual([
      ["suggest", "required"],
      ["resolve", "input_mismatch"],
      ["read", "wrong_kind"],
      ["create", "paired_function"],
    ]);
    expect(contactDirectoryIssues({ ...crmConfig, read: "customer.lookup" }, app, "en")).toEqual([
      { field: "read", code: "capability_missing", message: "“Read a contact”: customer.lookup does not exist in this app." },
    ]);
  });

  test("requires Cloud administration for loading and saving", async () => {
    const { deps, writes } = dependencies({ isAdmin: async () => false });
    const view = await loadContactDirectoryAdmin(context, crmConfig, "en", deps);
    expect(view.ok).toBeFalse();
    expect(await saveContactDirectory(context, crmConfig, "en", deps)).toMatchObject({ ok: false, status: 403 });
    expect(writes).toEqual([]);
  });
});

describe("request-local contact directory registration", () => {
  test("hides every function when the provider is unregistered", async () => {
    const { resolveRegisteredContactDirectory } = await import("./contact-directory");
    const { MAIL_CONTACT_DIRECTORY_DEFAULTS } = await import("../contact-directory-settings");
    expect(await resolveRegisteredContactDirectory(MAIL_CONTACT_DIRECTORY_DEFAULTS, async () => false)).toEqual({
      suggest: null,
      resolve: null,
      read: null,
      listWritableBooks: null,
      create: null,
    });
  });
  test("keeps registered mappings and transient registry failures", async () => {
    const { resolveRegisteredContactDirectory } = await import("./contact-directory");
    const { MAIL_CONTACT_DIRECTORY_DEFAULTS, DEFAULT_MAIL_CONTACT_DIRECTORY } = await import("../contact-directory-settings");
    expect(await resolveRegisteredContactDirectory(MAIL_CONTACT_DIRECTORY_DEFAULTS, async () => true)).toEqual(
      DEFAULT_MAIL_CONTACT_DIRECTORY,
    );
    expect(
      await resolveRegisteredContactDirectory(MAIL_CONTACT_DIRECTORY_DEFAULTS, async () => {
        throw new Error("Registry interrupted");
      }),
    ).toEqual(DEFAULT_MAIL_CONTACT_DIRECTORY);
  });
  test("never asks the registry about an invalid app ID", async () => {
    const { resolveRegisteredContactDirectory } = await import("./contact-directory");
    const { MAIL_CONTACT_DIRECTORY_DEFAULTS } = await import("../contact-directory-settings");
    let calls = 0;
    const result = await resolveRegisteredContactDirectory({ ...MAIL_CONTACT_DIRECTORY_DEFAULTS, appId: "Invalid App" }, async () => {
      calls++;
      return true;
    });
    expect(calls).toBe(0);
    expect(Object.values(result).every((value) => value === null)).toBe(true);
  });
});

test("contact directory carries unreadable keys and never rewrites omitted fallbacks", async () => {
  const key = MAIL_CONTACT_DIRECTORY_SETTING_KEYS.resolve;
  const { deps, writes } = dependencies({
    readSetting: async (setting) => ({
      value:
        setting === key
          ? crmConfig.resolve
          : new Map(
              Object.entries(MAIL_CONTACT_DIRECTORY_SETTING_KEYS).map(([field, setting]) => [
                setting,
                Object.entries(crmConfig).find(([name]) => name === field)![1],
              ]),
            ).get(setting)!,
      stored: setting === key ? "unreadable" : "readable",
    }),
  });
  const view = await loadContactDirectoryAdmin(context, crmConfig, "en", deps);
  expect(view.ok && view.data.unreadable?.[key]).toBe(true);
  await expect(saveContactDirectory(context, crmConfig, "en", deps)).rejects.toMatchObject({ code: "setting_unreadable" });
  expect(writes).toEqual([]);
  expect((await saveContactDirectory(context, { appId: "crm" }, "en", deps)).ok).toBe(true);
  expect(writes).toEqual([[MAIL_CONTACT_DIRECTORY_SETTING_KEYS.appId, "crm"]]);
  writes.length = 0;
  expect((await saveContactDirectory(context, { resolve: crmConfig.resolve, replaceUnreadable: [key] }, "en", deps)).ok).toBe(true);
  expect(writes).toEqual([[key, crmConfig.resolve]]);
});
