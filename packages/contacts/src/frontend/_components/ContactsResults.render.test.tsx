import { describe, expect, test } from "bun:test";
import { renderToString } from "solid-js/web";
import type { Contact } from "../../service";
import "./ssr-test-plugin";
import type { ContactsScope } from "./contacts-empty-state";
import { resultsMessages } from "./results-messages";

const { LocaleProvider } = await import("@k2b/ui");

const { default: ContactsResults } = await import("./ContactsResults.island.tsx");

const now = "2026-08-10T10:00:00.000Z";
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
  emails: [],
  phones: [],
  addresses: [],
  websites: [],
  bankAccounts: [],
  parentContactId: null,
  parent: null,
  members: [],
  tags: [],
};

describe("Contacts results", () => {
  test("renders the exact SSR snapshot without treating detail params as result source", () => {
    const html = renderToString(() => (
      <ContactsResults
        scope="book"
        bookId="team"
        initialHref="/app/contacts/team?search=Ada&contact=ada&contactBook=team"
        initialContacts={[contact]}
        initialTotal={1}
        initialPage={1}
        initialTotalPages={1}
        perPage={100}
        bookNames={{ team: "Team contacts" }}
        initialSelectedContactId={contact.id}
        initialSelectedBookId={contact.bookId}
        initialFavoriteKeys={[]}
        canWrite={false}
        writableBooks={[]}
      />
    ));

    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("1 result for “Ada”");
    expect(html).not.toContain("Loading contacts…");
    expect(html).toContain("/app/contacts/team?search=Ada&amp;contact=ada&amp;contactBook=team");
  });
});

const renderEmpty = (locale: string, scope: ContactsScope, href = "/app/contacts", canWrite = true) => {
  const writableBooks = canWrite && scope !== "noBooks" ? [{ id: "team", name: "Team" }] : [];
  return renderToString(() => (
    <LocaleProvider locale={locale}>
      <ContactsResults
        scope={scope}
        bookId={scope === "book" ? "team" : undefined}
        initialHref={href}
        initialContacts={[]}
        initialTotal={0}
        initialPage={1}
        initialTotalPages={1}
        perPage={100}
        bookNames={{}}
        initialSelectedContactId={null}
        initialSelectedBookId={null}
        initialFavoriteKeys={[]}
        canWrite={scope === "book" && canWrite}
        writableBooks={writableBooks}
      />
    </LocaleProvider>
  ));
};

for (const locale of ["en", "de"]) {
  describe(`Contacts empty results SSR (${locale})`, () => {
    const t = resultsMessages.resolve([locale]).t;
    const cases = [
      ["all", t.emptyAllTitle, t.emptyAllHint],
      ["book", t.emptyBookTitle, t.emptyBookHint],
      ["noBooks", t.emptyNoBooksTitle, t.emptyNoBooksHint],
    ] satisfies [ContactsScope, string, string][];
    for (const [scope, title, hint] of cases) {
      test(`renders the ${scope} title and hint from the initial snapshot`, () => {
        const html = renderEmpty(locale, scope, "/app/contacts");
        expect(html).toContain(title);
        expect(html).toContain(hint);
        if (scope === "noBooks") {
          expect(html).toContain(locale === "de" ? "Neues Kontaktbuch" : "New book");
          expect(html).toContain("ti-cube-plus");
          expect(html).toContain("<button");
        } else {
          expect(html).not.toContain("ti-cube-plus");
          expect(html).not.toContain("k2b-placeholder__action");
        }
      });
    }

    for (const scope of ["all", "book"] as const) {
      test(`favorites has its own empty state in ${scope}`, () => {
        const html = renderEmpty(locale, scope, `/app/contacts${scope === "book" ? "/team" : ""}?favorites=true`);
        expect(html).toContain(t.emptyFavoritesTitle);
        expect(html).toContain(t.emptyFavoritesHint);
        expect(html).not.toContain(t.noMatchingContacts);
      });
    }

    test("a tag filter shows no matches rather than an unfiltered empty hint", () => {
      const html = renderEmpty(locale, "all", "/app/contacts?tag_id=vip");
      expect(html).toContain(t.noMatchingContacts);
      expect(html).toContain(t.noMatchingFiltersHint);
      expect(html).not.toContain(t.emptyAllTitle);
      expect(html).not.toContain("No contacts yet");
    });

    test("noBooks still offers book creation with a search and filters", () => {
      const html = renderEmpty(locale, "noBooks", "/app/contacts?search=Ada&tag_id=vip&email=yes&favorites=true");
      expect(html).toContain(t.emptyNoBooksTitle);
      expect(html).toContain(t.emptyNoBooksHint);
      expect(html).not.toContain(t.noMatchingContacts);
    });

    for (const scope of ["all", "book"] satisfies ContactsScope[]) {
      test(`read-only ${scope} explains how contacts appear`, () => {
        const html = renderEmpty(locale, scope, "/app/contacts", false);
        expect(html).toContain(scope === "all" ? t.emptyAllTitle : t.emptyBookTitle);
        expect(html).toContain(t.emptyReadOnlyHint);
        expect(html).not.toContain(scope === "all" ? t.emptyAllHint : t.emptyBookHint);
      });
    }
  });
}
