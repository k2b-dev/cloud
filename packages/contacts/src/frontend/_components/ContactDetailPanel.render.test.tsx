import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { Contact, ContactNote, ContactTree } from "../../service";
import "./ssr-test-plugin";

const { default: ContactDetailPanel } = await import("./ContactDetailPanel.tsx");
const { default: ContactOrgTreeView } = await import("./ContactOrgTreeView.tsx");
const { default: ContactNotesSection } = await import("./ContactNotesSection.tsx");
const { default: ContactsWorkspace } = await import("./ContactsWorkspace.island.tsx");
const { AppWorkspace, LocaleProvider } = await import("@k2b/ui");

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
      location: null,
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
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de-CH",
      get children() {
        return createComponent(ContactNotesSection, {
          bookId: contact.bookId,
          contactId: contact.id,
          currentUserId: "user-1",
          initialNotesPage: { items: [{ ...note, updatedAt: "2026-08-09T10:05:00.000Z" }], page: 1, perPage: 30, total: 1, hasNext: false },
          canWrite: true,
        });
      },
    }),
  );

  expect(html).toContain("Notizen");
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

test.each([false, true])("SSR places contacts in main levels and gives the unselected list the full area (selected=%s)", (selected) => {
  const html = renderToString(() =>
    createComponent(AppWorkspace, {
      get children() {
        return createComponent(AppWorkspace.Content, {
          get children() {
            return createComponent(ContactsWorkspace, {
              list: {
                scope: "book",
                title: "Team",
                description: "Team contacts",
                total: 1,
                search: "Ada",
                resultHref: "/app/contacts/team?search=Ada&contact=ada&contactBook=team",
                bookId: "team",
                perPage: 30,
                searchPlaceholder: "Search contacts",
                contacts: [contact],
                bookNames: { team: "Team" },
                initialSelectedContactId: selected ? contact.id : null,
                initialSelectedBookId: selected ? contact.bookId : null,
                writableBooks: [],
                defaultCreateBookId: null,
                currentPage: 1,
                totalPages: 1,
                initialFavoriteKeys: [],
              },
              reader: {
                initialContact: selected ? contact : null,
                initialContactId: selected ? contact.id : null,
                initialBookId: selected ? contact.bookId : null,
                initialNotesPage: { items: [], page: 1, perPage: 30, total: 0, hasNext: false },
                contacts: [contact],
                bookNames: { team: "Team" },
                writableBooks: [],
                adminBookIds: [],
                memberBookIds: [],
                currentUserId: "user-1",
                initialFavoriteKeys: [],
                timeZone: "UTC",
              },
            });
          },
        });
      },
    }),
  );
  expect(html).toContain(`data-workspace-level-count="${selected ? 2 : 1}"`);
  expect(html).toContain('data-workspace-main-region="contacts-list"');
  expect(html.includes('data-workspace-main-region="contacts-reader"')).toBe(selected);
  expect(html).not.toContain('class="k2b-app-workspace__detail');
  if (selected) expect(html).toContain('href="/app/contacts/team?search=Ada"');
});

describe("Contact birthday calendar dates (#1232)", () => {
  const previousTZ = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = "America/New_York";
    setSystemTime(new Date("2026-08-09T10:00:00.000Z"));
  });

  afterAll(() => {
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
    setSystemTime();
  });

  const renderBirthday = (birthday: string, locale: string) => {
    const birthdayContact = { ...contact, birthday };
    return renderToString(() =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(ContactDetailPanel, {
            initialContact: birthdayContact,
            initialContactId: birthdayContact.id,
            initialBookId: birthdayContact.bookId,
            initialNotesPage: { items: [], page: 1, perPage: 30, total: 0, hasNext: false },
            contacts: [birthdayContact],
            bookNames: { team: "Team contacts" },
            writableBooks: [],
            adminBookIds: [],
            memberBookIds: [],
            currentUserId: "user-1",
            showEmpty: false,
            initialFavoriteKeys: [],
            timeZone: "UTC",
          });
        },
      }),
    );
  };

  test.each([
    ["en", "May 12, 1990"],
    ["de", "12. Mai 1990"],
  ])("preserves the birthday west of UTC in %s", (locale, expected) => {
    const html = renderBirthday("1990-05-12", locale);
    expect(html).toContain(expected);
    for (const shifted of ["5/11/1990", "May 11", "11. Mai"]) expect(html).not.toContain(shifted);
  });

  test("preserves invalid stored birthday text in its row", () => {
    const html = renderBirthday("not-a-date", "en");
    const birthdayRow = html.match(/<dt>Birthday<\/dt><dd>([\s\S]*?)<\/dd>/)?.[1];
    expect(birthdayRow).toContain("not-a-date");
    expect(birthdayRow).not.toContain("—");
  });
});

describe("Contacts reader page", () => {
  test("who has access stands first under More about for members of the book, and is absent for public-only readers", () => {
    const render = (memberBookIds: string[]) =>
      renderToString(() =>
        createComponent(ContactDetailPanel, {
          initialContact: contact,
          initialContactId: contact.id,
          initialBookId: contact.bookId,
          initialNotesPage: { items: [], page: 1, perPage: 30, total: 0, hasNext: false },
          contacts: [contact],
          bookNames: { team: "Team contacts" },
          writableBooks: [],
          adminBookIds: [],
          memberBookIds,
          currentUserId: "user-1",
          showEmpty: false,
          initialFavoriteKeys: [],
          timeZone: "UTC",
        }),
      );
    const member = render([contact.bookId]);
    const more = member.slice(member.indexOf("More about Ada Lovelace"));
    // The list loads after the first paint and keeps its place meanwhile.
    expect(more).toMatch(/>Access<\/span>[\s\S]*Loading who has access/);
    expect(more.indexOf(">Access<")).toBeLessThan(more.indexOf(">Properties<"));
    expect(more).not.toContain("Manage access");
    expect(render([])).not.toContain(">Access<");
  });
  test("composes a reader page with framed topics in order and flat secondary details", () => {
    const html = renderToString(() =>
      createComponent(ContactDetailPanel, {
        initialContact: contact,
        initialContactId: contact.id,
        initialBookId: contact.bookId,
        initialNotesPage: { items: [note], page: 1, perPage: 30, total: 1, hasNext: false },
        contacts: [contact],
        bookNames: { team: "Team contacts" },
        writableBooks: [{ id: "team", name: "Team contacts" }],
        adminBookIds: ["team"],
        memberBookIds: [],
        currentUserId: "user-1",
        showEmpty: false,
        initialFavoriteKeys: [],
        timeZone: "UTC",
      }),
    );

    expect(html).toContain('<article class="contacts-reader');
    expect(html).not.toContain('class="k2b-detail-panel"');
    expect(html).toContain("<h2>Ada Lovelace</h2>");
    expect(html).toContain('class="k2b-detail-panel__header-leading"');
    expect(html).toMatch(/class="k2b-avatar [^"]*" data-size="lg"/);
    for (const icon of ["ti-list-details", "ti-address-book", "ti-map-pin", "ti-message-circle", "ti-sitemap", "ti-user", "ti-briefcase"])
      expect(html).toContain(`ti ${icon}`);
    expect(html).toMatch(
      />Reach<\/h2>[\s\S]*>Addresses<\/h2>[\s\S]*>Relationships<\/h2>[\s\S]*>Notes<\/h2>[\s\S]*>More about Ada Lovelace<\/h2>/,
    );
    expect(html.match(/data-size="md" data-frame="line" data-icon="true"/g)).toHaveLength(5);
    expect(html).toContain("data-print-region");
    expect(html).toMatch(/<a href="mailto:ada@example.com" class="k2b-button contacts-details-main[^"]*"[^>]*data-variant="subtle"/);
    expect(html).toContain('aria-label="More contact actions"');
    expect(html).toContain(">Properties</h3>");
    expect(html).not.toContain('class="k2b-detail-panel__group"');
    expect(html.match(/<section class="k2b-section[^"]*"[^>]*data-open="true"/g)).toBeNull();
    for (const summary of ["Birthday, Pronouns, Language", "Company, Department, Job title, VAT ID"]) expect(html).toContain(summary);
    expect(html).toContain('data-scroll-preserve="contacts-detail"');
    expect(html).toContain('data-layout="rows"');
    expect(html).toContain('href="mailto:ada@example.com"');
    expect(html).toContain('href="tel:+44 20 7946 0958"');
    expect(html).toContain("Relationships");
    expect(html).toContain("Notes");
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
    expect(html).not.toContain("k2b-detail-panel__body");
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
    const html = renderToString(() =>
      createComponent(ContactDetailPanel, {
        initialContact: sparseContact,
        initialContactId: sparseContact.id,
        initialBookId: sparseContact.bookId,
        initialNotesPage: { items: [], page: 1, perPage: 30, total: 0, hasNext: false },
        contacts: [sparseContact],
        bookNames: { team: "Team contacts" },
        writableBooks: [],
        adminBookIds: [],
        memberBookIds: [],
        currentUserId: "user-1",
        showEmpty: false,
        initialFavoriteKeys: [],
        timeZone: "UTC",
      }),
    );

    expect(html).toContain("Read only contact");
    expect(html).toContain("Properties");
    expect(html).toContain("Notes");
    // Only "More actions" (vCard) remains: no way to write, mail, or call.
    expect(html).toContain('aria-label="More contact actions"');
    expect(html).not.toContain("contacts-details-main");
    expect(html).not.toContain('class="k2b-detail-panel__group"');
    expect(html).not.toContain("Reach");
    expect(html).not.toContain("Relationships");
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
            children: [
              {
                id: "katherine",
                label: null,
                firstName: "Katherine",
                lastName: "Johnson",
                companyName: "NASA",
                jobTitle: "Mathematician",
                parentContactId: "grace",
                children: [],
              },
            ],
          },
        ],
      },
    };

    const html = renderToString(() => createComponent(ContactOrgTreeView, { tree, onSelect: () => {}, onBack: () => {} }));

    expect(html).toContain('class="k2b-detail-panel"');
    expect(html).toContain('data-scroll-preserve="contacts-org-tree"');
    expect(html).toContain("<h2>Org tree</h2>");
    expect(html).not.toContain("k2b-detail-panel__header-icon");
    expect(html).toMatch(/class="k2b-detail-panel__kind"[^>]*>(<[^>]+>)*Organization</);
    expect(html).toContain('aria-label="Organization context"');
    expect(html).toContain("Grace Hopper");
    expect(html).toContain("Katherine Johnson");
    expect(html).not.toMatch(/(?<![\w-])border-[lt](?![\w-])/);
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    const selectedButton = html.match(/<button\b[^>]*aria-current="true"[^>]*>([\s\S]*?)<\/button>/)?.[1];
    expect(selectedButton).toContain("Grace Hopper");
    expect(html.match(/<ul\b/g)).toHaveLength(3);
    expect(html.match(/<ul class="[^"]*\bpl-9\b[^"]*"/g)).toHaveLength(2);
    expect(html).toMatch(/<ul\b[^>]*>[\s\S]*<ul\b[^>]*>[\s\S]*<ul\b[^>]*>[\s\S]*<\/ul>[\s\S]*<\/ul>[\s\S]*<\/ul>/);
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
    for (const className of legacyDetailClasses) expect(html).not.toContain(className);
  });
});

describe("Focused address workspace SSR", () => {
  const render = (initialAddressId: string, writable = true) =>
    renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return createComponent(ContactDetailPanel, {
            initialContact: contact,
            initialContactId: contact.id,
            initialBookId: contact.bookId,
            initialAddressId,
            initialNotesPage: { items: [], page: 1, perPage: 30, total: 0, hasNext: false },
            contacts: [contact],
            bookNames: { team: "Team contacts" },
            writableBooks: writable ? [{ id: "team", name: "Team contacts" }] : [],
            adminBookIds: [],
            memberBookIds: [],
            currentUserId: "user-1",
            initialFavoriteKeys: [],
            timeZone: "UTC",
            geoAvailability: { configured: false, person: { exhausted: false, resetsAt: now }, cloud: { exhausted: false, resetsAt: now } },
          });
        },
      }),
    );
  test("renders the selected address editor in the first server response without a dialog", () => {
    const html = render("address-1");
    expect(html).toContain('class="contacts-address-editor"');
    expect(html).toContain("Adresse bearbeiten");
    expect(html).toContain("Office · Ada Lovelace");
    expect(html).toContain('value="1 Engine Way"');
    expect(html).toContain("Adresszusatz");
    expect(html).toContain("PLZ");
    expect(html).toContain("Land");
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("k2b-panel-dialog");
  });
  test("does not render inputs for a removed address or a readonly contact", () => {
    for (const html of [render("removed"), render("address-1", false)]) {
      expect(html).toContain("Adresse nicht verfügbar");
      expect(html).toContain("Zurück zum Kontakt");
      expect(html).not.toContain('class="contacts-address-editor"');
      expect(html).not.toContain("<input");
    }
  });
});
