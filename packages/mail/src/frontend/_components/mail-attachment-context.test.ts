import { describe, expect, test } from "bun:test";
import type { CapabilityCatalogClientResult } from "@k2b/cloud/capabilities";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { type CapabilityCatalog, contactDirectory, defineCapabilities } from "@k2b/cloud/contracts";
import type { ContactDirectoryTarget } from "../../contact-directory";
import type { resolveContacts } from "./contact-capabilities";
import { resolveAttachmentContext } from "./mail-attachment-context";

type Dependencies = NonNullable<Parameters<typeof resolveAttachmentContext>[1]>;
const directory = { appId: "contacts", capabilityId: "mapped.resolve" };
const recipients = [
  { name: null, address: " B@example.test " },
  { name: null, address: "a@example.test" },
  { name: null, address: "b@example.test" },
];
const app = (appId: string, ids = ["contact.resolve"]): CapabilityCatalog["apps"][number] => ({
  appId,
  appName: appId,
  appIcon: "ti ti-users",
  appDescription: "",
  manifest: compileCapabilityManifest(
    appId,
    defineCapabilities({
      protocolVersion: 2,
      queries: Object.fromEntries(
        ids.map((id) => [
          id,
          {
            input: contactDirectory.resolve.input,
            data: contactDirectory.resolve.data,
            title: "Match contacts",
            description: "Find readable exact matches.",
            openWorld: false,
            run: async () => ({ ok: false as const, error: { code: "INTERNAL", message: "Not called", status: 500 } }),
          },
        ]),
      ),
    }),
  ),
});
const catalog = (apps: CapabilityCatalog["apps"], nextCursor?: string): CapabilityCatalogClientResult => ({
  ok: true,
  data: { protocolVersion: 2, apps, page: nextCursor ? { hasMore: true, nextCursor } : { hasMore: false } },
});
const item = (type: string, id: string, email: string) => ({
  ref: { type, id },
  contactId: id,
  bookId: "book",
  bookName: "Book",
  displayName: "Person",
  companyName: null,
  jobTitle: null,
  contactPointsTruncated: false,
  updatedAt: "2026-10-16T12:00:00.000Z",
  matchedEmails: [email],
  emails: [],
  phones: [],
});
const resolution = (items: ReturnType<typeof item>[]): Awaited<ReturnType<typeof resolveContacts>> => ({
  data: { items, matchedEmails: [] },
});
const signal = () => new AbortController().signal;

describe("attachment recipient context", () => {
  test("uses all catalog pages, one compatible query per app, four concurrent lookups, recipient/provider/item order and bounded refs", async () => {
    const apps = [
      app("customers", ["customer.match"]),
      app("ambiguous", ["one.resolve", "two.resolve"]),
      app("failed"),
      app("slow"),
      app("contacts", ["contact.resolve", "mapped.resolve"]),
      app("default", ["contact.resolve", "other.resolve"]),
    ];
    const cursors: (string | undefined)[] = [];
    const calls: ContactDirectoryTarget[] = [];
    let active = 0;
    let peak = 0;
    const context = await resolveAttachmentContext(
      { directory, recipients, signal: signal() },
      {
        listCatalog: async (options) => {
          cursors.push(options?.cursor);
          return options?.cursor ? catalog(apps.slice(4)) : catalog(apps.slice(0, 4), "page2");
        },
        timeout: () => AbortSignal.timeout(1),
        resolve: async (target, input, bounded) => {
          expect(input).toEqual({ emails: ["b@example.test", "a@example.test"], limit: 50 });
          expect(target).not.toBeNull();
          calls.push(target!);
          peak = Math.max(peak, ++active);
          try {
            if (target!.appId === "slow") {
              await new Promise((_, reject) => bounded!.addEventListener("abort", () => reject(bounded!.reason), { once: true }));
            }
            await Promise.resolve();
            if (target!.appId === "failed") throw new Error("Refused");
            if (target!.appId === "contacts")
              return resolution([
                item("contacts.contact", "a", "a@example.test"),
                item("contacts.contact", "b", "b@example.test"),
                item("contacts.contact", "b", "b@example.test"),
                item("contacts.contact", "", "b@example.test"),
                item("contacts.contact", "unrelated", "other@example.test"),
              ]);
            if (target!.appId === "customers")
              return resolution([item("customers.customer", "a", "a@example.test"), item("customers.customer", "b", "b@example.test")]);
            return resolution(Array.from({ length: 25 }, (_, index) => item("default.contact", String(index), "a@example.test")));
          } finally {
            active--;
          }
        },
      },
    );
    expect(cursors).toEqual([undefined, "page2"]);
    expect(calls).toEqual([
      directory,
      { appId: "customers", capabilityId: "customer.match" },
      { appId: "failed", capabilityId: "contact.resolve" },
      { appId: "slow", capabilityId: "contact.resolve" },
      { appId: "default", capabilityId: "contact.resolve" },
    ]);
    expect(peak).toBe(4);
    expect(context.refs).toEqual([
      { type: "contacts.contact", id: "b" },
      { type: "customers.customer", id: "b" },
      { type: "contacts.contact", id: "a" },
      { type: "customers.customer", id: "a" },
      ...Array.from({ length: 16 }, (_, index) => ({ type: "default.contact", id: String(index) })),
    ]);
    expect(JSON.stringify(context)).not.toContain("@");
  });

  test("catalog failure falls back only to the configured directory", async () => {
    const calls: (ContactDirectoryTarget | null)[] = [];
    const context = await resolveAttachmentContext(
      { directory, recipients, signal: signal() },
      {
        listCatalog: async () => {
          throw new Error("Offline");
        },
        resolve: async (target) => {
          calls.push(target);
          return resolution([item("contacts.contact", "b", "b@example.test")]);
        },
      },
    );
    expect(calls).toEqual([directory]);
    expect(context).toEqual({ refs: [{ type: "contacts.contact", id: "b" }] });
  });

  test("guards a non-advancing catalog cursor and uses the configured fallback", async () => {
    let reads = 0;
    const context = await resolveAttachmentContext(
      { directory, recipients, signal: signal() },
      {
        listCatalog: async () => {
          reads++;
          return catalog([app("customers")], "same");
        },
        resolve: async (target) => {
          expect(target).toEqual(directory);
          return resolution([]);
        },
      },
    );
    expect(reads).toBe(2);
    expect(context).toEqual({ refs: [] });
  });

  test("no recipients makes no network call; no configured fallback returns no refs", async () => {
    let calls = 0;
    const noNetwork: Dependencies = {
      listCatalog: async () => {
        calls++;
        throw new Error("Offline");
      },
      resolve: async () => {
        calls++;
        throw new Error("Must not run");
      },
    };
    expect(await resolveAttachmentContext({ directory, recipients: [], signal: signal() }, noNetwork)).toEqual({ refs: [] });
    expect(calls).toBe(0);
    expect(await resolveAttachmentContext({ directory: null, recipients, signal: signal() }, noNetwork)).toEqual({ refs: [] });
    expect(calls).toBe(1);
  });

  test("caps normalized recipient emails at 25", async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ name: null, address: `person${index}@example.test` }));
    await resolveAttachmentContext(
      { directory, recipients: many, signal: signal() },
      {
        listCatalog: async () => catalog([app("contacts", ["mapped.resolve"])]),
        resolve: async (_target, input) => {
          expect(input.emails).toEqual(many.slice(0, 25).map((recipient) => recipient.address));
          return resolution([]);
        },
      },
    );
  });

  test("only caller cancellation rejects, during catalog discovery or a provider lookup", async () => {
    for (const stage of ["catalog", "resolve"]) {
      const controller = new AbortController();
      const started = Promise.withResolvers<void>();
      const wait = (bounded?: AbortSignal) =>
        new Promise<never>((_, reject) => {
          started.resolve();
          bounded!.addEventListener("abort", () => reject(bounded!.reason), { once: true });
        });
      const pending = resolveAttachmentContext(
        { directory, recipients, signal: controller.signal },
        {
          listCatalog: async (options) => (stage === "catalog" ? wait(options?.signal) : catalog([app("contacts", ["mapped.resolve"])])),
          resolve: async (_target, _input, bounded) => wait(bounded),
        },
      );
      await started.promise;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    }
  });
});
