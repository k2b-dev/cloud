import { describe, expect, test } from "bun:test";
import { renderToString } from "solid-js/web";
import type { Contact, ContactNote, ContactTree } from "../../service";
import "./ssr-test-plugin";

const { default: ContactDetailPanel } = await import("./ContactDetailPanel.island.tsx");
const { default: ContactOrgTreeView } = await import("./ContactOrgTreeView.tsx");
const { default: ContactNotesSection } = await import("./ContactNotesSection.tsx");
const { LocaleProvider } = await import("@k2b/ui");

const now = "2026-08-09T10:00:00.000Z";

const contact: Contact = {
  id: "ada",
  bookId: "team",
  label: null,
  firstName: "Ada",
  lastName: "Lovelace",
  companyName: "Analytical Engines",
  department: "Research",
  jobTitle: "Programmer",
  vatId: "GB-1843",
  birthday: "1815-12-10",
  salutation: null,
  pronouns: "she/her",
  preferredLanguage: "en",
  source: null,
  createdAt: now,
  updatedAt: now,
  emails: [
    {
      id: "email-1",
      contactId: "ada",
      label: "Work",
      email: "ada@example.com",
      position: 0,
      createdAt: now,
      updatedAt: now,
    },
  ],
  phones: [
    {
      id: "phone-1",
      contactId: "ada",
      label: "Office",
      phone: "+44 20 7946 0958",
      position: 0,
      createdAt: now,
      updatedAt: now,
    },
  ],
  websites: [
    {
      id: "site-1",
      contactId: "ada",
      label: "Profile",
      url: "https://example.com/ada",
      position: 0,
      createdAt: now,
      updatedAt: now,
    },
  ],
  addresses: [
    {
      id: "address-1",
      contactId: "ada",
      label: "Office",
      recipientName: "Ada Lovelace",
      companyName: "Analytical Engines",
      line1: "1 Engine Way",
      line2: null,
      postalCode: "SW1A 1AA",
      city: "London",
      stateRegion: null,
      countryCode: "GB",
      position: 0,
      createdAt: now,
      updatedAt: now,
    },
  ],
  bankAccounts: [],
  parentContactId: null,
  parent: null,
  members: [
    {
      id: "grace",
      label: null,
      firstName: "Grace",
      lastName: "Hopper",
      companyName: "US Navy",
      jobTitle: "Rear admiral",
    },
  ],
  tags: [
    {
      id: "tag-1",
      bookId: "team",
      name: "Research",
      color: "blue",
      createdAt: now,
      updatedAt: now,
    },
  ],
};

const note: ContactNote = {
  id: "note-1",
  contactId: contact.id,
  authorUserId: "user-1",
  authorDisplayName: "Valentin Kolb",
  authorAvatarHash: null,
  content: "Follow up next week.",
  createdAt: now,
  updatedAt: now,
  canEdit: true,
  canDelete: true,
};

test("localizes the complete comments surface through the inherited locale", () => {
  const html = renderToString(() => (
    <LocaleProvider locale="de-CH">
      <ContactNotesSection
        bookId={contact.bookId}
        contactId={contact.id}
        currentUserId="user-1"
        initialNotesPage={{ items: [{ ...note, updatedAt: "2026-08-09T10:05:00.000Z" }], page: 1, perPage: 30, total: 1, hasNext: false }}
        canWrite
      />
    </LocaleProvider>
  ));

  expect(html).toContain("Kommentare");
  expect(html).toContain("Kommentar hinzufügen");
  expect(html).toContain('aria-label="Kommentar bearbeiten"');
  expect(html).toContain('aria-label="Kommentar löschen"');
  expect(html).toContain("bearbeitet");
  expect(html).not.toContain("Add comment");
});

const legacyDetailClasses = [
  'class="detail-header',
  'class="detail-stack',
  'class="detail-section',
  'class="detail-row',
  'class="detail-facts',
];

describe("Contacts detail panels", () => {
  test("composes contact details from the shared grouped panel contract", () => {
    const html = renderToString(() => (
      <ContactDetailPanel
        initialContact={contact}
        initialContactId={contact.id}
        initialBookId={contact.bookId}
        initialNotesPage={{ items: [note], page: 1, perPage: 30, total: 1, hasNext: false }}
        contacts={[contact]}
        bookNames={{ team: "Team contacts" }}
        writableBooks={[{ id: "team", name: "Team contacts" }]}
        adminBookIds={["team"]}
        currentUserId="user-1"
        showEmpty={false}
        initialFavoriteKeys={[]}
      />
    ));

    expect(html).toContain('class="k2b-detail-panel"');
    expect(html).toContain("<h2>Ada Lovelace</h2>");
    expect(html).toContain('class="k2b-detail-panel__header-leading"');
    expect(html).toContain('class="k2b-detail-panel__primary-actions"');
    expect(html).toContain('class="k2b-detail-panel__summary"');
    expect(html).toContain('aria-label="Contact information"');
    expect(html).toContain('aria-label="Additional details"');
    expect(html.match(/<details class="k2b-detail-panel__section" open/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Organization context"');
    expect(html).toContain('class="k2b-detail-panel__section-icon" data-tone="accent"');
    expect(html).toContain('data-scroll-preserve="contacts-detail"');
    expect(html).toContain('data-layout="rows"');
    expect(html).toContain('href="mailto:ada@example.com"');
    expect(html).toContain('href="tel:+44 20 7946 0958"');
    expect(html).toContain("Organization");
    expect(html).toContain("Comments");
    expect(html).toContain('class="k2b-discussion');
    expect(html).toContain('class="k2b-discussion__item');
    expect(html).toContain('aria-label="Edit comment"');
    expect(html).toContain('class="ti ti-pencil"');
    expect(html).toContain('aria-label="Delete comment"');
    expect(html).toContain("Follow up next week.");
    expect(html).toContain("Grace Hopper");
    expect(html).toContain("k2b-tag__label");
    expect(html).toContain('data-size="lg"');
    expect(html).toContain("ti ti-point k2b-tag__icon");
    expect(html).toContain("Research");
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
    for (const className of legacyDetailClasses) expect(html).not.toContain(className);
  });

  test("keeps sparse read-only contacts sparse and omits write controls", () => {
    const sparseContact: Contact = {
      ...contact,
      id: "readonly",
      firstName: null,
      lastName: null,
      label: "Read only contact",
      companyName: null,
      department: null,
      jobTitle: null,
      vatId: null,
      birthday: null,
      pronouns: null,
      preferredLanguage: null,
      emails: [],
      phones: [],
      websites: [],
      addresses: [],
      parentContactId: null,
      parent: null,
      members: [],
      tags: [],
    };
    const html = renderToString(() => (
      <ContactDetailPanel
        initialContact={sparseContact}
        initialContactId={sparseContact.id}
        initialBookId={sparseContact.bookId}
        initialNotesPage={{ items: [], page: 1, perPage: 30, total: 0, hasNext: false }}
        contacts={[sparseContact]}
        bookNames={{ team: "Team contacts" }}
        writableBooks={[]}
        adminBookIds={[]}
        currentUserId="user-1"
        showEmpty={false}
        initialFavoriteKeys={[]}
      />
    ));

    expect(html).toContain("Read only contact");
    expect(html).toContain("Overview");
    expect(html).toContain("Comments");
    expect(html).not.toContain('class="k2b-detail-panel__primary-actions"');
    expect(html).not.toContain('class="k2b-detail-panel__group"');
    expect(html).not.toContain("Reach");
    expect(html).not.toContain("Organization");
    expect(html).not.toContain("Quick edit");
    expect(html).not.toContain("Add comment");
  });

  test("uses the same panel and single scroll owner for the organization tree", () => {
    const tree: ContactTree = {
      bookId: "team",
      selectedId: "grace",
      root: {
        id: "ada",
        label: null,
        firstName: "Ada",
        lastName: "Lovelace",
        companyName: "Analytical Engines",
        jobTitle: "Programmer",
        parentContactId: null,
        children: [
          {
            id: "grace",
            label: null,
            firstName: "Grace",
            lastName: "Hopper",
            companyName: "US Navy",
            jobTitle: "Rear admiral",
            parentContactId: "ada",
            children: [],
          },
        ],
      },
    };

    const html = renderToString(() => <ContactOrgTreeView tree={tree} onSelect={() => {}} onBack={() => {}} />);

    expect(html).toContain('class="k2b-detail-panel"');
    expect(html).toContain('data-scroll-preserve="contacts-org-tree"');
    expect(html).toContain("<h2>Org tree</h2>");
    expect(html).toContain('class="k2b-detail-panel__header-icon"');
    expect(html).toContain('aria-label="Organization context"');
    expect(html).toContain("Grace Hopper");
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
    for (const className of legacyDetailClasses) expect(html).not.toContain(className);
  });
});
