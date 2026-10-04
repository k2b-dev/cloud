import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../ui/test/dom";
import type { Contact, ContactRef } from "../src/service";

/** The lines the shared polite status region of `@k2b/ui` reads, once its announcement delay has passed. */
const announcements = async (document: Document) => {
  await Bun.sleep(150);
  return [...document.querySelectorAll('[data-k2b-live] [role="status"] > div')].map((line) => line.textContent);
};

const now = "2026-10-03T10:00:00.000Z";
const member: ContactRef = { id: "Cont02", label: null, firstName: "Tom", lastName: "Sample", companyName: null, jobTitle: null };
const parent: Contact = {
  id: "Cont01",
  bookId: "Book01",
  label: null,
  firstName: null,
  lastName: null,
  companyName: "Sample GmbH",
  department: null,
  jobTitle: null,
  vatId: null,
  birthday: null,
  salutation: null,
  pronouns: null,
  preferredLanguage: null,
  source: null,
  createdAt: now,
  updatedAt: now,
  emails: [],
  phones: [],
  addresses: [],
  websites: [],
  bankAccounts: [],
  parentContactId: null,
  parent: null,
  members: [member],
  tags: [],
};

describe("Contact member removal feedback", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  let dom: DomTestHarness;
  const originalFetch = globalThis.fetch;
  const patches: unknown[] = [];
  beforeAll(() => {
    dom = createDomTestHarness();
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        patches.push(JSON.parse(String(init?.body)));
        return Response.json({ ...member, parentContactId: null });
      },
      { preconnect: originalFetch.preconnect },
    );
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
    dom.cleanup();
  });

  /** Removes the member after confirmation, with `reload` standing in for the contact detail reload. */
  const removeMember = async (reload: () => Promise<void>) => {
    const { createContactDetailActions } = await import("../src/frontend/_components/ContactDetailPanel.actions");
    const { prompts } = await import("@k2b/ui");
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    patches.length = 0;
    dom.document.querySelector("[data-k2b-live]")?.remove();
    let dispose!: () => void;
    try {
      await createRoot((disposeRoot) => {
        dispose = disposeRoot;
        const [orgTreeSource, setOrgTreeSource] = createSignal<string | null>(null);
        const [, setDetailMode] = createSignal<"details" | "tree">("details");
        const actions = createContactDetailActions({
          bookId: () => "Book01",
          writableBooks: [{ id: "Book01", name: "Customers" }],
          orgTreeSource,
          setOrgTreeSource,
          setDetailMode,
          invalidateDetail: reload,
        });
        return actions.unlinkMember(member, parent);
      });
      expect(patches).toEqual([{ parentContactId: null }]);
      return await announcements(dom.document);
    } finally {
      dispose();
      confirm.mockRestore();
    }
  };

  test("a removed member is announced to screen readers once the contact shows it, with no toast", async () => {
    const { toast } = await import("@k2b/ui");
    const successes = spyOn(toast, "success").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    const errors = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    try {
      expect(await removeMember(async () => {})).toEqual(["Member removed"]);
      expect(successes).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      successes.mockRestore();
      errors.mockRestore();
    }
  });

  test("a removed member whose contact cannot be reloaded is not announced, because the error toast says it was removed", async () => {
    const { toast } = await import("@k2b/ui");
    const errors = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    try {
      expect(await removeMember(() => Promise.reject(new Error("Service unavailable")))).toEqual([]);
      expect(errors.mock.calls).toEqual([["The member was removed, but the contact could not be reloaded."]]);
    } finally {
      errors.mockRestore();
    }
  });
});
