import { afterEach, describe, expect, test } from "bun:test";
import {
  ContactDirectoryUnavailableError,
  createContact,
  listWritableContactBooks,
  readContact,
  resolveContacts,
  suggestContacts,
} from "./contact-capabilities";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const customerId = "c9a1f7de-5a53-4f67-9e3c-0f1a2b3c4d5e";
const customer = {
  contactId: customerId,
  bookId: "customers",
  displayName: "Ada Example",
  companyName: "Example Ltd",
  jobTitle: null,
  emails: [{ label: null, email: "ada@example.test" }],
  phones: [],
  contactPointsTruncated: false,
  updatedAt: "2026-09-20T08:00:00.000Z",
  customerNumber: "K-1001",
};

const recordRequests = (data: (path: string) => unknown) => {
  const requests: Array<{ path: string; body: unknown; idempotencyKey: string | null }> = [];
  globalThis.fetch = Object.assign(
    async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = String(request);
      requests.push({ path, body: JSON.parse(String(init?.body)), idempotencyKey: new Headers(init?.headers).get("idempotency-key") });
      return Response.json({ data: data(path), page: { hasMore: false } });
    },
    { preconnect: originalFetch.preconnect },
  );
  return requests;
};

describe("Mail contact-directory calls", () => {
  test("call the mapped third-party capabilities with the contract input", async () => {
    const requests = recordRequests((path) => {
      if (path.endsWith("/customer.suggest")) return [customer];
      if (path.endsWith("/customer.match"))
        return {
          items: [
            { ...customer, ref: { type: "crm.customer", id: customerId }, bookName: "Customers", matchedEmails: ["ada@example.test"] },
          ],
          matchedEmails: ["ada@example.test"],
        };
      if (path.endsWith("/customer.read") || path.endsWith("/customer.create")) {
        const { contactId: _contactId, ...rest } = customer;
        const contact = { ...rest, id: customerId };
        return path.endsWith("/customer.read") ? contact : { contact };
      }
      return [{ id: "customers", name: "Customers", description: null }];
    });

    const suggestions = await suggestContacts({ appId: "crm", capabilityId: "customer.suggest" }, { query: "ada", limit: 8 });
    const matches = await resolveContacts({ appId: "crm", capabilityId: "customer.match" }, { emails: ["ada@example.test"], limit: 50 });
    const read = await readContact({ appId: "crm", capabilityId: "customer.read" }, customerId);
    const books = await listWritableContactBooks({ appId: "crm", capabilityId: "segment.list" }, { limit: 25 });
    const created = await createContact(
      { appId: "crm", capabilityId: "customer.create" },
      { bookId: "customers", label: "Ada Example", emails: [{ label: "Email", email: "ada@example.test" }] },
      "create-once",
    );

    expect(suggestions.data[0]?.customerNumber).toBe("K-1001");
    expect(matches.data.items[0]?.ref).toEqual({ type: "crm.customer", id: customerId });
    expect(read.data.emails).toEqual([{ label: null, email: "ada@example.test" }]);
    expect(books.data).toEqual([{ id: "customers", name: "Customers", description: null }]);
    expect(created.data.contact.id).toBe(customerId);
    expect(requests).toEqual([
      { path: "/api/capabilities/v1/queries/crm/customer.suggest", body: { input: { query: "ada", limit: 8 } }, idempotencyKey: null },
      {
        path: "/api/capabilities/v1/queries/crm/customer.match",
        body: { input: { emails: ["ada@example.test"], limit: 50 } },
        idempotencyKey: null,
      },
      { path: "/api/capabilities/v1/queries/crm/customer.read", body: { input: { id: customerId } }, idempotencyKey: null },
      {
        path: "/api/capabilities/v1/queries/crm/segment.list",
        body: { input: { limit: 25, minimumPermission: "write" } },
        idempotencyKey: null,
      },
      {
        path: "/api/capabilities/v1/actions/crm/customer.create",
        body: { input: { bookId: "customers", label: "Ada Example", emails: [{ label: "Email", email: "ada@example.test" }] } },
        idempotencyKey: "create-once",
      },
    ]);
  });

  test("reject provider data that breaks the contract", async () => {
    recordRequests(() => [{ ...customer, displayName: null }]);
    await expect(suggestContacts({ appId: "crm", capabilityId: "customer.suggest" }, { query: "ada" })).rejects.toThrow();
  });

  test("never call an unmapped function", async () => {
    const requests = recordRequests(() => []);
    await expect(createContact(null, { bookId: "customers" }, "create-once")).rejects.toBeInstanceOf(ContactDirectoryUnavailableError);
    expect(requests).toEqual([]);
  });
});
