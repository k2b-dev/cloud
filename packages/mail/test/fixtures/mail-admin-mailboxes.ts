import type { MailAdminMailboxesProps, MailAdminMailboxRow } from "../../src/frontend/_components/v2/MailAdminMailboxes.island";
import type { ContactDirectoryAdminView } from "../../src/service/contact-directory";
import { keptAdminNav } from "./mail-admin-kept";

// Invented mailboxes of a firm for Cloud administration › Mail › Mailboxes: most sync, a few need someone. Times are
// already worded as the page words them for a fixed clock.

type Seed = [
  name: string,
  health: MailAdminMailboxRow["health"],
  sync: string | null,
  admins: number,
  people: number,
  storage: string | null,
  attention: number,
];

const ok = { label: "Aktiv" } as const;
const seeds: Seed[] = [
  ["Verwaltung", ok, "vor 2 Min.", 2, 6, "4,2 GB", 0],
  ["Kundendienst", ok, "vor 1 Min.", 1, 14, "11,8 GB", 0],
  ["Buchhaltung", { label: "Verbindet neu", status: "warn" }, "vor 38 Min.", 1, 4, "2,9 GB", 3],
  ["Geschäftsführung", ok, "vor 4 Min.", 1, 2, "1,1 GB", 0],
  ["Personal", ok, "vor 3 Min.", 0, 3, "860 MB", 0],
  ["Einkauf", ok, "vor 2 Min.", 2, 5, "3,4 GB", 0],
  ["Datenschutz", { label: "Pausiert" }, "vor 6 Tagen", 1, 2, "120 MB", 0],
  ["Rechnungseingang", { label: "Gestört", status: "bad" }, "gestern, 17:20", 1, 3, "6,7 GB", 12],
  ["Bewerbungen", ok, "vor 9 Min.", 1, 4, "2,2 GB", 0],
  ["Lager Nord", ok, "vor 5 Min.", 0, 1, "340 MB", 1],
  ["Presse", { label: "Wird geprüft", status: "warn" }, null, 1, 2, null, 0],
  ["IT-Service", ok, "vor 1 Min.", 3, 7, "5,0 GB", 0],
];

export const mailboxRows = (): MailAdminMailboxRow[] =>
  seeds.map(([name, health, sync, administrators, people, storage, attention], index) => ({
    id: `Mbx${String(index + 1).padStart(3, "0")}`,
    name,
    health,
    sync: sync ? { text: sync, title: sync, iso: "2026-11-26T09:28:00.000Z" } : null,
    administrators,
    people,
    storage,
    attention,
  }));

export const contactDirectoryView = (): ContactDirectoryAdminView => ({
  config: {
    appId: "contacts",
    suggest: "contact.suggest",
    resolve: "contact.resolve",
    read: "contact.read",
    listWritableBooks: "book.list",
    create: "contact.create",
  },
  apps: [
    {
      appId: "contacts",
      appName: "Kontakte",
      appIcon: "ti ti-address-book",
      capabilities: {
        suggest: [{ id: "contact.suggest", title: "Kontakte vorschlagen" }],
        resolve: [{ id: "contact.resolve", title: "Kontakte zuordnen" }],
        read: [{ id: "contact.read", title: "Kontakt lesen" }],
        listWritableBooks: [{ id: "book.list", title: "Adressbücher" }],
        create: [{ id: "contact.create", title: "Kontakt anlegen" }],
      },
    },
  ],
  issues: [],
});

export const mailboxesProps = (overrides: Partial<MailAdminMailboxesProps> = {}): MailAdminMailboxesProps => ({
  nav: keptAdminNav("de", "mailboxes"),
  rows: mailboxRows(),
  figures: { mailboxes: 12, withoutAdministrator: 2, attention: 16, storage: { value: "38,6 GB", meta: "aktualisiert vor 12 Min." } },
  contactDirectory: contactDirectoryView(),
  failure: null,
  query: "",
  nextCursor: null,
  ...overrides,
});
