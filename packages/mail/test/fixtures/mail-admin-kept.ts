import { dates } from "@k2b/stdlib";
import type { NavProps } from "@k2b/ui/v2";
import type { KeptConversationExport } from "../../src/contracts";
import type { MailAdminKeptRow } from "../../src/frontend/_components/v2/MailAdminKeptList.island";
import type { KeepHistoryEntry } from "../../src/service/kept-conversations";

// Invented data for Cloud administration › Mail › Kept: a firm that keeps conversations as evidence (leases, claims,
// staff matters). Names and domains are made up (example.org); the clock is fixed so every date reads the same.

export const KEPT_NOW = "2026-11-26T09:30:00.000Z";
export const keptDateConfig = { locale: "de", timeZone: "Europe/Berlin" } as const;

/** The admin bar as `adminNavigation(c, mailAdminSections(locale, "kept"))` builds it for an administrator. */
export const keptAdminNav = (locale: "de" | "en" = "de", current: "kept" | "mailboxes" = "kept"): NavProps => {
  const de = locale === "de";
  return {
    title: de ? "Verwaltung" : "Admin",
    icon: "settings",
    groups: [
      {
        items: [
          { label: de ? "Übersicht" : "Overview", icon: "gauge", href: "/admin" },
          { label: "Apps", icon: "apps", href: "/admin/apps", count: 14 },
          { label: de ? "Konten" : "Accounts", icon: "users", href: "/admin/accounts" },
          { label: de ? "Speicher" : "Storage", icon: "database", href: "/admin/storage" },
        ],
      },
      {
        label: "Apps",
        items: [
          { label: "Mail", icon: "mail", href: "/admin/mail" },
          { label: de ? "Postfächer" : "Mailboxes", icon: "inbox", href: "/admin/mail", nested: true, current: current === "mailboxes" },
          { label: de ? "Sicherheit" : "Security", icon: "shield-lock", href: "/admin/mail/security", nested: true },
          { label: de ? "Aufbewahrt" : "Kept", icon: "lock", href: "/admin/mail/kept", nested: true, current: current === "kept" },
          { label: "Dateien", icon: "folders", href: "/admin/files" },
          { label: "Grids", icon: "table", href: "/admin/grids" },
          { label: "Notebooks", icon: "notebook", href: "/admin/notebooks" },
          { label: "KI", icon: "sparkles", href: "/admin/ai" },
        ],
      },
    ],
  };
};

const at = (iso: string) => ({
  text: dates.formatDate(iso, keptDateConfig),
  title: dates.formatDateTime(iso, keptDateConfig),
  iso,
});

type Seed = [subject: string, mailbox: string, sender: string, last: string, keptBy: string, keptAt: string, deleted?: boolean];

const seeds: Seed[] = [
  ["Kündigung Mietvertrag Lindenstraße 14", "Verwaltung", "Paul Weber", "2026-11-25T16:12:00Z", "Jana Berger", "2026-11-25T17:02:00Z"],
  ["Gewährleistung Lastenrad LR-2207", "Kundendienst", "Lena Fischer", "2026-11-24T10:40:00Z", "Tobias Rehm", "2026-11-24T11:15:00Z"],
  [
    "Mahnung Rechnung 2026-0412, dritte Stufe",
    "Buchhaltung",
    "inkasso@forderung.example.org",
    "2026-11-22T08:05:00Z",
    "Jana Berger",
    "2026-11-23T09:30:00Z",
  ],
  [
    "Abmahnung wegen Bildrechten auf der Website",
    "Geschäftsführung",
    "Kanzlei Roth & Partner",
    "2026-11-21T14:22:00Z",
    "Mira Solberg",
    "2026-11-21T15:00:00Z",
  ],
  ["Arbeitszeugnis und Aufhebungsvertrag S. Kern", "Personal", "Sami Kern", "2026-11-20T12:48:00Z", "Mira Solberg", "2026-11-20T13:10:00Z"],
  [
    "Projekt Nordlicht: Abnahmeprotokoll",
    "Projekt Nordlicht",
    "Felix Thal",
    "2026-10-30T09:12:00Z",
    "Tobias Rehm",
    "2026-11-02T08:00:00Z",
    true,
  ],
  [
    "Reklamation Lieferung 4711, Palette beschädigt",
    "Einkauf",
    "Spedition Falk",
    "2026-11-19T07:55:00Z",
    "Tobias Rehm",
    "2026-11-19T08:20:00Z",
  ],
  [
    "Datenschutzanfrage nach Art. 15 DSGVO",
    "Datenschutz",
    "Ottilie Brandner",
    "2026-11-18T18:31:00Z",
    "Jana Berger",
    "2026-11-19T07:45:00Z",
  ],
  [
    "Angebot Rahmenvertrag Reinigung 2027",
    "Einkauf",
    "Glanzwerk Service GmbH",
    "2026-11-17T11:02:00Z",
    "Tobias Rehm",
    "2026-11-17T11:30:00Z",
  ],
  ["Unfallmeldung Lager Nord, 14. November", "Personal", "Jonas Kern", "2026-11-14T15:40:00Z", "Mira Solberg", "2026-11-14T16:05:00Z"],
  ["Steuerprüfung 2024: Unterlagen", "Buchhaltung", "Finanzamt Lahr", "2026-11-13T09:00:00Z", "Jana Berger", "2026-11-13T09:20:00Z"],
  ["Widerspruch gegen Kündigung", "Personal", "Ada Renz", "2026-11-12T10:10:00Z", "Mira Solberg", "2026-11-12T10:45:00Z"],
  [
    "Versicherungsfall Wasserschaden Büro 2.04",
    "Verwaltung",
    "Allgemeine Versicherung",
    "2026-11-10T08:30:00Z",
    "Jana Berger",
    "2026-11-10T09:00:00Z",
  ],
  [
    "Projekt Nordlicht: Schlussrechnung",
    "Projekt Nordlicht",
    "Architekturbüro Winter",
    "2026-10-28T13:00:00Z",
    "Tobias Rehm",
    "2026-11-02T08:01:00Z",
    true,
  ],
  ["Lieferantenwechsel Verpackung", "Einkauf", "Karton Nord", "2026-11-07T14:12:00Z", "Tobias Rehm", "2026-11-07T15:00:00Z"],
  ["Beschwerde über Kundendienst-Termin", "Kundendienst", "Hotel Seeblick", "2026-11-06T17:21:00Z", "Tobias Rehm", "2026-11-07T08:10:00Z"],
  [
    "Vertragsstrafe wegen Lieferverzug",
    "Geschäftsführung",
    "Stadtwerke Auental",
    "2026-11-05T09:44:00Z",
    "Mira Solberg",
    "2026-11-05T10:30:00Z",
  ],
  ["Bewerbung: Rückfrage zur Absage", "Personal", "Noah Becker", "2026-11-04T19:03:00Z", "Mira Solberg", "2026-11-05T07:50:00Z"],
];

const address = (name: string) =>
  name.includes("@")
    ? name
    : `${name
        .toLowerCase()
        .replace(/[^a-z]+/g, ".")
        .replace(/^\.|\.$/g, "")}@example.org`;

/** A list page as the server builds it from `listKeptConversations`, newest keep first. */
export const keptRows = (count = seeds.length): MailAdminKeptRow[] =>
  Array.from({ length: count }, (_, index) => {
    const [subject, mailboxName, sender, last, keptBy, keptAt, deleted] = seeds[index % seeds.length]!;
    const round = Math.floor(index / seeds.length);
    return {
      mailboxId: `Box${String((index % 7) + 1).padStart(3, "0")}`,
      conversationId: `Con${String(index + 1).padStart(4, "0")}`,
      href: `/admin/mail/kept/Box${String((index % 7) + 1).padStart(3, "0")}/Con${String(index + 1).padStart(4, "0")}`,
      mailboxName,
      mailboxDeleted: deleted === true,
      subject: round ? `${subject} (${round + 1})` : subject,
      sender: sender.includes("@") ? address(sender) : sender,
      date: at(last),
      keptBy,
      keptSince: at(keptAt),
    };
  });

/** The worst case of one page (break-ui): long, unbroken, foreign, empty and extreme values. */
export const keptWorstRows = (): MailAdminKeptRow[] => [
  {
    ...keptRows(1)[0]!,
    conversationId: "ConW001",
    subject:
      "AW: AW: WG: Nachtrag Nr. 17 zum Generalunternehmervertrag Bauvorhaben Oberhauser-Wettstein-Straße 1234a, Hinterhaus, Gewerk Elektro, Mängelanzeige",
    mailboxName: "Rechtsabteilung und Vertragsmanagement Süd-West",
    sender: "bartholomew.fitzgerald-oberhauser@northwind-industries-holdings.example.org",
    keptBy: "Aleksandra Wiśniewska-Kowalczyk",
  },
  { ...keptRows(2)[1]!, conversationId: "ConW002", subject: "X", mailboxName: "Ö", sender: "J", keptBy: "Ö" },
  {
    ...keptRows(3)[2]!,
    conversationId: "ConW003",
    subject: "شكوى بخصوص الفاتورة رقم ٤٥١٢",
    sender: "ليلى عبد الرحمن",
    mailboxName: "خدمة العملاء",
  },
  { ...keptRows(4)[3]!, conversationId: "ConW004", subject: "关于合同续签的通知", sender: "王秀英", mailboxDeleted: true },
  {
    ...keptRows(5)[4]!,
    conversationId: "ConW005",
    subject: "👩‍👩‍👧‍👦 Familienfest – Fotos & Einverständnis 📸",
    date: null,
    sender: "Unbekannter Absender",
  },
  ...keptRows(12).slice(5),
];

type KeptConversation = KeptConversationExport["conversations"][number];
type KeptMessage = KeptConversation["messages"][number];
type Attachment = KeptMessage["attachments"][number];

let ids = 0;
/** A short public id, as the export names messages and attachments. */
const publicId = () => `Fx${String(++ids).padStart(4, "0")}`;
const file = (filename: string, contentType: string, size: number): Attachment => ({
  id: publicId(),
  filename,
  contentType,
  size,
  inline: false,
  contentId: null,
});
const message = (
  fields: Pick<KeptMessage, "subject" | "date" | "from" | "to" | "cc" | "bcc" | "replyTo" | "messageId" | "text" | "html" | "attachments"> &
    Partial<Pick<KeptMessage, "delivery">>,
): KeptMessage => ({ id: publicId(), delivery: null, inReplyTo: null, references: [], headers: {}, ...fields });

/** The record of the first kept conversation: three messages, one sent by Cloud and cancelled, with its history. */
export const keptRecord = (): { conversation: KeptConversation; history: KeepHistoryEntry[]; messageCount: number } => ({
  conversation: {
    cloudId: "Box001/Con0001",
    mailbox: { id: "Box001", name: "Verwaltung" },
    conversationId: "Con0001",
    subject: "Kündigung Mietvertrag Lindenstraße 14",
    keep: { keptAt: "2026-11-25T17:02:00.000Z", keptBy: { kind: "user", displayName: "Jana Berger" } },
    messages: [
      message({
        subject: "AW: Kündigung Mietvertrag Lindenstraße 14",
        date: "2026-11-25T16:12:00.000Z",
        from: [{ name: "Paul Weber", address: "paul.weber@example.org" }],
        to: [{ name: "Verwaltung", address: "verwaltung@werkstatt.example.org" }],
        cc: [{ name: "Kanzlei Roth & Partner", address: "kanzlei@roth-partner.example.org" }],
        bcc: [],
        replyTo: [],
        messageId: "<20261125161200.4471@mail.example.org>",
        text: "Sehr geehrte Damen und Herren,\n\nhiermit bestätige ich den Eingang Ihrer Kündigung vom 20. November. Die Übergabe der Räume schlage ich für Freitag, den 19. Dezember, um 10 Uhr vor.\n\nBitte bringen Sie alle Schlüssel mit, auch die für den Keller und den Briefkasten. Das Übergabeprotokoll schicke ich Ihnen vorab.\n\nMit freundlichen Grüßen\nPaul Weber",
        html: null,
        attachments: [file("Übergabeprotokoll-Entwurf.pdf", "application/pdf", 184_320), file("Lageplan-Keller.png", "image/png", 742_112)],
      }),
      message({
        subject: "AW: Kündigung Mietvertrag Lindenstraße 14",
        date: "2026-11-21T09:02:00.000Z",
        from: [{ name: "Jana Berger", address: "jana.berger@werkstatt.example.org" }],
        to: [{ name: "Paul Weber", address: "paul.weber@example.org" }],
        cc: [],
        bcc: [{ name: "Ablage", address: "ablage@werkstatt.example.org" }],
        replyTo: [],
        messageId: "<cloud-7Q2M@werkstatt.example.org>",
        text: "Guten Tag Herr Weber,\n\nwir haben den Entwurf zurückgezogen und senden Ihnen die Kündigung gesondert per Einschreiben.\n\nJana Berger",
        html: null,
        attachments: [],
        delivery: { state: "cancelled" },
      }),
      message({
        subject: "Kündigung Mietvertrag Lindenstraße 14",
        date: "2026-11-20T14:40:00.000Z",
        from: [{ name: "Jana Berger", address: "jana.berger@werkstatt.example.org" }],
        to: [{ name: "Paul Weber", address: "paul.weber@example.org" }],
        cc: [],
        bcc: [],
        replyTo: [{ name: "Verwaltung", address: "verwaltung@werkstatt.example.org" }],
        messageId: "<cloud-6P1K@werkstatt.example.org>",
        text: null,
        html: '<p>Sehr geehrter Herr Weber,</p><p>wir kündigen den Mietvertrag über die Räume in der <b>Lindenstraße 14</b> fristgerecht zum 31. Dezember 2026.</p><p><img src="https://tracker.example.org/pixel.gif" alt="">Mit freundlichen Grüßen<br>Jana Berger, Verwaltung</p>',
        attachments: [file("Kündigung-Lindenstraße-14.pdf", "application/pdf", 96_256)],
        delivery: { state: "sent" },
      }),
    ],
  },
  messageCount: 3,
  history: [
    {
      action: "mail.conversation.keep.view",
      outcome: "allowed",
      at: "2026-11-26T08:58:00.000Z",
      actor: { label: "Tobias Rehm" },
      reason: null,
    },
    {
      action: "mail.conversation.keep.release",
      outcome: "denied",
      at: "2026-11-26T08:40:00.000Z",
      actor: { label: "Sami Kern" },
      reason: "Frist abgelaufen",
    },
    {
      action: "mail.conversation.keep.export",
      outcome: "allowed",
      at: "2026-11-25T17:20:00.000Z",
      actor: { label: "Jana Berger" },
      reason: null,
    },
    {
      action: "mail.conversation.keep",
      outcome: "allowed",
      at: "2026-11-25T17:02:00.000Z",
      actor: { label: "Jana Berger" },
      reason: "Rechtsstreit möglich",
    },
  ],
});
