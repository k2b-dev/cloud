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
    const lookupTimeouts: AbortController[] = [];
    let active = 0;
    let peak = 0;
    const context = await resolveAttachmentContext(
      { directory, recipients, signal: signal() },
      {
        listCatalog: async (options) => {
          cursors.push(options?.cursor);
          return options?.cursor ? catalog(apps.slice(4)) : catalog(apps.slice(0, 4), "page2");
        },
        timeout: () => {
          const controller = new AbortController();
          lookupTimeouts.push(controller);
          return controller.signal;
        },
        resolve: async (target, input, bounded) => {
          expect(input).toEqual({ emails: ["b@example.test", "a@example.test"], limit: 50 });
          expect(target).not.toBeNull();
          calls.push(target!);
          peak = Math.max(peak, ++active);
          try {
            if (target!.appId === "slow") {
              lookupTimeouts.at(-1)!.abort(new DOMException("Timed out", "TimeoutError"));
              throw bounded!.reason;
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

  test("no recipients makes no network call; catalog failure without a configured fallback rejects", async () => {
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
    await expect(resolveAttachmentContext({ directory: null, recipients, signal: signal() }, noNetwork)).rejects.toMatchObject({
      name: "Error",
    });
    expect(calls).toBe(1);
  });

  test("every lookup failing or returning after its deadline rejects with a non-abort Error", async () => {
    for (const lateResult of [false, true]) {
      const deadline = new AbortController();
      await expect(
        resolveAttachmentContext(
          { directory, recipients, signal: signal() },
          {
            listCatalog: async () => catalog([app("contacts"), app("customers")]),
            timeout: () => deadline.signal,
            resolve: async () => {
              if (!lateResult) throw new Error("Refused");
              deadline.abort(new DOMException("Timed out", "TimeoutError"));
              return resolution([]);
            },
          },
        ),
      ).rejects.toMatchObject({ name: "Error" });
    }
  });

  test("one failing contact app does not suppress another app's refs or successful empty result", async () => {
    for (const items of [[item("customers.customer", "b", "b@example.test")], []]) {
      const context = await resolveAttachmentContext(
        { directory, recipients, signal: signal() },
        {
          listCatalog: async () => catalog([app("contacts"), app("customers")]),
          resolve: async (target) => {
            if (target?.appId === "contacts") throw new Error("Offline");
            return resolution(items);
          },
        },
      );
      expect(context).toEqual({ refs: items.map((match) => match.ref) });
    }
  });

  test("one catalog deadline covers all pages and falls back to the configured directory", async () => {
    for (const fallback of [directory, null]) {
      const deadline = new AbortController();
      const started = Promise.withResolvers<void>();
      let reads = 0;
      let deadlines = 0;
      const pending = resolveAttachmentContext(
        { directory: fallback, recipients, signal: signal() },
        {
          catalogTimeout: () => {
            deadlines++;
            return deadline.signal;
          },
          listCatalog: async (options) => {
            if (++reads === 1) return catalog([app("customers")], "page2");
            return new Promise<never>((_, reject) => {
              options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
              started.resolve();
            });
          },
          resolve: async (target) => {
            expect(target).toEqual(directory);
            return resolution([item("contacts.contact", "b", "b@example.test")]);
          },
        },
      );
      await started.promise;
      deadline.abort(new DOMException("Timed out", "TimeoutError"));
      if (fallback) expect(await pending).toEqual({ refs: [{ type: "contacts.contact", id: "b" }] });
      else await expect(pending).rejects.toMatchObject({ name: "Error" });
      expect(reads).toBe(2);
      expect(deadlines).toBe(1);
    }
  });

  test("a readable catalog without a compatible contact app returns no refs", async () => {
    expect(
      await resolveAttachmentContext(
        { directory: null, recipients, signal: signal() },
        {
          listCatalog: async () => catalog([app("unrelated", [])]),
          resolve: async () => {
            throw new Error("Must not run");
          },
        },
      ),
    ).toEqual({ refs: [] });
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

  test("caller cancellation preserves its reason during catalog discovery or a provider lookup", async () => {
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
      const reason = new Error("Caller cancelled");
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
    }
  });
});
