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

/** Mailboxes at their limits (break-ui): names of 160 characters, emoji, Chinese, missing sync and storage, huge numbers. */
export const mailboxWorstRows = (): MailAdminMailboxRow[] => [
  {
    ...mailboxRows()[0]!,
    name: "Rechtsabteilung und Vertragsmanagement Süd-West – Nachlässe, Mietrecht, Gewährleistung, Bauvorhaben Oberhauser-Wettstein-Straße 1234a und Hinterhaus (2026)",
    storage: "12,4 TB",
    attention: 12_345,
    people: 1_284,
  },
  { ...mailboxRows()[1]!, id: "Mbx0X2", name: "J", sync: null, storage: null, administrators: 0, people: 0 },
  { ...mailboxRows()[2]!, id: "Mbx0X3", name: "客户服务 · 售后支持", health: { label: "Verbindet neu", status: "warn" } },
  { ...mailboxRows()[3]!, id: "Mbx0X4", name: "📮 Poststelle 👩‍👩‍👧‍👦 Familienkasse", health: { label: "Unbekannt", status: "bad" } },
  ...mailboxRows().slice(4),
];

export const mailboxesWorstProps = (): MailAdminMailboxesProps =>
  mailboxesProps({
    rows: mailboxWorstRows(),
    figures: {
      mailboxes: 1_284,
      withoutAdministrator: 312,
      attention: 98_765,
      storage: { value: "1.284,6 TB", meta: "noch nicht abgeglichen" },
    },
    contactDirectory: {
      ...contactDirectoryView(),
      config: { ...contactDirectoryView().config, appId: "crm-northwind-industries-holdings-kundenverwaltung" },
      apps: [],
      issues: [{ field: "resolve", code: "capability_missing", message: "missing" }],
    },
    failure: "Der Speicherstand konnte nicht geladen werden. Der Dienst antwortet nicht.",
  });

/** A full page of the service (50 rows) out of 500 mailboxes. */
export const mailboxesHugeProps = (): MailAdminMailboxesProps =>
  mailboxesProps({
    rows: Array.from({ length: 50 }, (_, index) => ({
      ...mailboxRows()[index % 12]!,
      id: `M${String(index).padStart(5, "0")}`,
      name: `${mailboxRows()[index % 12]!.name} ${index + 1}`,
    })),
    figures: { mailboxes: 500, withoutAdministrator: 0, attention: 0, storage: { value: "3,2 TB", meta: "aktualisiert vor 4 Std." } },
    nextCursor: "next",
  });

export const mailboxesEmptyProps = (): MailAdminMailboxesProps =>
  mailboxesProps({ rows: [], figures: { mailboxes: 0, withoutAdministrator: 0, attention: 0, storage: null }, contactDirectory: null });
