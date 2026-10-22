import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { Contact } from "../../service";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return (await import("./ContactsList")).default;
  } finally {
    dom.cleanup();
  }
};
const ContactsList = isServer ? undefined : await load();

const now = "2026-10-17T12:00:00.000Z";
const contact: Contact = {
  id: "ada",
  bookId: "team",
  label: null,
  firstName: "Ada",
  lastName: "Lovelace",
  companyName: null,
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
  emails: [{ id: "email-1", contactId: "ada", label: "Work", email: "ada@example.com", position: 0, createdAt: now, updatedAt: now }],
  phones: [{ id: "phone-1", contactId: "ada", label: "Work", phone: "+442079460958", position: 0, createdAt: now, updatedAt: now }],
  addresses: [],
  websites: [],
  bankAccounts: [],
  parentContactId: null,
  parent: null,
  members: [],
  tags: [],
};

describe("Contacts list selection", () => {
  if (!ContactsList) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  beforeEach(() => setSystemTime(new Date(now)));
  afterEach(() => setSystemTime());

  test("clicking the shared checkbox toggles the contact exactly once", () => {
    const dom = createDomTestHarness();
    delegateEvents(["click", "change"], dom.document);
    const onToggleSelection = mock((_contactId: string) => {});
    let dispose: (() => void) | undefined;
    try {
      dispose = render(
        () => (
          <ContactsList
            contacts={[contact]}
            initialSelectedContactId={null}
            initialSelectedBookId={null}
            detailBaseHref="/app/contacts/team"
            initialFavoriteKeys={[]}
            selectionMode
            selectedIds={[]}
            onToggleSelection={onToggleSelection}
          />
        ),
        dom.root,
      );
      const checkbox = dom.root.querySelector<HTMLInputElement>('input[type="checkbox"][aria-label="Select Ada Lovelace"]');
      expect(checkbox).not.toBeNull();
      checkbox!.click();
      expect(onToggleSelection).toHaveBeenCalledTimes(1);
      expect(onToggleSelection).toHaveBeenCalledWith(contact.id);
    } finally {
      dispose?.();
      dom.cleanup();
    }
  });
});
