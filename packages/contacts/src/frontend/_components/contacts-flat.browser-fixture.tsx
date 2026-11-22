import { appAccentStyle } from "@k2b/cloud/ssr/app-appearance";
import { AppWorkspace, LocaleProvider, PageTrailProvider } from "@k2b/ui";
import type { Contact, ContactNote, ContactTag } from "../../service";
import ContactsSidebar from "./ContactsSidebar";
import ContactsWorkspace from "./ContactsWorkspace.island";

// Invented people only; every timestamp is fixed.
const AT = "2026-11-21T10:00:00.000Z";
const BOOK = "team";

const tags: ContactTag[] = [
  { id: "tag-customer", bookId: BOOK, name: "Kunde", color: "#16a34a", createdAt: AT, updatedAt: AT },
  { id: "tag-supplier", bookId: BOOK, name: "Lieferant", color: "#2563eb", createdAt: AT, updatedAt: AT },
];

const NAMES = [
  ["Henrike", "Vossberg", "Vossberg Antik", "Inhaberin"],
  ["Jonas", "Weil", "Spedition Weil & Söhne", "Disposition"],
  ["Mira", "Ost", null, null],
  ["Ella", "Brandt", "Bäckerei Lind", "Einkauf"],
  ["Tom", "Riegel", "Riegel Elektrotechnik GmbH", "Geschäftsführer"],
  ["Ada", "Kranich", "Stadtwerke Musterstadt", "Kundenservice"],
  ["Levin", "Achterberg", null, "Bote"],
  ["Jonte", "Kramer", "Kramer & Partner Steuerberatung", "Steuerberater"],
  ["Lea", "Sommer", "Galerie am Markt", "Kuratorin"],
  ["Paul", "Engel", "Engel Logistik", "Lager"],
  ["Nora", "Fink", "Fink Druck", "Satz und Layout"],
  ["Emil", "Hartmann", "Hartmann Holzbau", "Meister"],
  ["Greta", "Lorenz", "Praxis Dr. Lorenz", "Ärztin"],
  ["Karl", "Neumann", "Neumann Immobilien", "Makler"],
  ["Ida", "Wolff", "Wolff Textil", "Vertrieb"],
  ["Fritz", "Bauer", "Hofladen Bauer", "Inhaber"],
  ["Lotte", "Krüger", "Krüger Versicherungen", "Beraterin"],
  ["Anton", "Schulze", null, null],
  ["Marie", "Zimmermann", "Zimmermann Architekten", "Partnerin"],
  ["Oskar", "Becker", "Autohaus Becker", "Service"],
  ["Clara", "Hoffmann", "Hoffmann Musikschule", "Leitung"],
  ["Ben", "Schäfer", "Schäfer Gartenbau", "Gärtner"],
] as const;

const contact = (index: number, full: boolean): Contact => {
  const [firstName, lastName, companyName, jobTitle] = NAMES[index]!;
  const id = `contact-${index + 1}`;
  const mail = `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.test`;
  return {
    id,
    bookId: BOOK,
    label: null,
    firstName,
    lastName,
    companyName,
    department: full ? "Ankauf" : null,
    jobTitle,
    vatId: full ? "DE123456789" : null,
    birthday: full ? "1984-03-14" : null,
    salutation: full ? "Frau" : null,
    pronouns: null,
    preferredLanguage: full ? "Deutsch" : null,
    source: null,
    createdAt: AT,
    updatedAt: AT,
    emails:
      index % 5 === 2 ? [] : [{ id: `${id}-mail`, contactId: id, label: "Arbeit", email: mail, position: 0, createdAt: AT, updatedAt: AT }],
    phones:
      index % 3 === 1
        ? []
        : [
            {
              id: `${id}-phone`,
              contactId: id,
              label: "Mobil",
              phone: `+49 30 2312${String(index).padStart(4, "0")}`,
              position: 0,
              createdAt: AT,
              updatedAt: AT,
            },
          ],
    addresses: full
      ? [
          {
            id: `${id}-address`,
            contactId: id,
            label: "Laden",
            recipientName: null,
            companyName,
            line1: "Lindenweg 8",
            line2: null,
            postalCode: "12345",
            city: "Musterstadt",
            stateRegion: null,
            countryCode: "DE",
            location: null,
            position: 0,
            createdAt: AT,
            updatedAt: AT,
          },
        ]
      : [],
    websites: full
      ? [
          {
            id: `${id}-web`,
            contactId: id,
            label: null,
            url: "https://vossberg-antik.example.test",
            position: 0,
            createdAt: AT,
            updatedAt: AT,
          },
        ]
      : [],
    bankAccounts: full
      ? [
          {
            id: `${id}-bank`,
            contactId: id,
            label: null,
            accountHolderName: `${firstName} ${lastName}`,
            iban: "DE02120300000000202051",
            bic: "BYLADEM1001",
            bankName: "Beispielbank",
            note: null,
            position: 0,
            createdAt: AT,
            updatedAt: AT,
          },
        ]
      : [],
    parentContactId: null,
    parent: null,
    members: full
      ? [{ id: "contact-7", label: null, firstName: "Levin", lastName: "Achterberg", companyName: null, jobTitle: "Bote" }]
      : [],
    tags: index % 4 === 0 ? [tags[0]!] : index % 4 === 1 ? [tags[1]!] : [],
  };
};

const notes: ContactNote[] = [
  {
    id: "note-1",
    contactId: "contact-1",
    authorUserId: "user-1",
    authorDisplayName: "Mira Solberg",
    authorAvatarHash: null,
    content: "Fragt nach dem Stand der Liste V41b. Rückruf am Montag zugesagt.",
    createdAt: AT,
    updatedAt: AT,
    canEdit: true,
    canDelete: true,
  },
];

export type ContactsScenario = "few" | "many" | "empty" | "record" | "sparse";

/** The contacts workspace: two or twenty-two contacts, an empty book, a full record beside the list, a sparse one. */
export default function ContactsFlatFixture(props: { scenario: ContactsScenario }) {
  const count = props.scenario === "few" ? 2 : props.scenario === "empty" ? 0 : NAMES.length;
  const contacts = Array.from({ length: count }, (_, index) => contact(index, false));
  const selected =
    props.scenario === "record" ? contact(0, true) : props.scenario === "sparse" ? { ...contact(2, false), emails: [], phones: [] } : null;
  const book = { id: BOOK, name: "Team-Kontakte", description: "Geteiltes Kontaktbuch des Teams", createdAt: AT, updatedAt: AT };
  return (
    <LocaleProvider locale="de">
      <PageTrailProvider trail={{ title: book.name, ancestors: [{ title: "Kontakte", href: "/app/contacts" }] }}>
        <div class="app-accent-scope contents" style={appAccentStyle("#4f46e5")}>
          <AppWorkspace mobileSurface="flush">
            <ContactsSidebar
              books={[book, { ...book, id: "private", name: "Privat", description: null }]}
              active={BOOK}
              adminBookIds={[BOOK]}
            />
            <AppWorkspace.Content>
              <ContactsWorkspace
                list={{
                  scope: "book",
                  title: book.name,
                  description: book.description,
                  total: contacts.length,
                  search: "",
                  resultHref: `/app/contacts/${BOOK}`,
                  bookId: BOOK,
                  perPage: 50,
                  searchPlaceholder: "Team-Kontakte durchsuchen",
                  contacts,
                  bookNames: { [BOOK]: book.name },
                  initialSelectedContactId: selected?.id ?? null,
                  initialSelectedBookId: selected ? BOOK : null,
                  writableBooks: [{ id: BOOK, name: book.name }],
                  defaultCreateBookId: BOOK,
                  currentPage: 1,
                  totalPages: 1,
                  tags,
                  activeTagId: null,
                  filtersBasePath: `/app/contacts/${BOOK}`,
                  initialFavoriteKeys: [],
                }}
                reader={{
                  initialContact: selected,
                  initialContactId: selected?.id ?? null,
                  initialBookId: selected ? BOOK : null,
                  initialNotesPage: {
                    items: props.scenario === "record" ? notes : [],
                    page: 1,
                    perPage: 30,
                    total: props.scenario === "record" ? 1 : 0,
                    hasNext: false,
                  },
                  contacts,
                  bookNames: { [BOOK]: book.name },
                  writableBooks: [{ id: BOOK, name: book.name }],
                  adminBookIds: [BOOK],
                  memberBookIds: [BOOK],
                  currentUserId: "user-1",
                  showEmpty: false,
                  initialFavoriteKeys: [],
                  timeZone: "Europe/Berlin",
                }}
              />
            </AppWorkspace.Content>
          </AppWorkspace>
        </div>
      </PageTrailProvider>
    </LocaleProvider>
  );
}
