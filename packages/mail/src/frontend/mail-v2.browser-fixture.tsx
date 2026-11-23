import { LocaleProvider } from "@k2b/ui";
import { DEFAULT_MAIL_CONTACT_DIRECTORY } from "../contact-directory-settings";
import type { MailboxPageData, MailListItem, MailWorkspaceMessage } from "../service/workspace";
import { mailTestRow } from "./_components/mail-list-test-fixtures";
import { summaryState } from "./_components/mail-summary-fixtures";
import { readMailUserPreferencesFromCookieHeader } from "./_components/mail-user-preferences";
import { readMailWorkspacePreferences } from "./_components/mail-workspace-preferences";
import MailWorkspace from "./MailWorkspace.island";
import { mailboxData, sidebar } from "./mail-shell.browser-fixture";

import { MAIL_V2_NOW } from "./mail-v2.browser-clock";

/*
 * Mail's mailbox on the v2 pilot with the invented conversations of the approved v2 mockup (mail.html): the real
 * island, controller and SSR, only the data is made up. The tests freeze the clock at `MAIL_V2_NOW`.
 */

const minutesAgo = (now: number, minutes: number) => new Date(now - minutes * 60_000).toISOString();
const DAY = 24 * 60;

const people = [
  { id: "user-mira", displayName: "Mira Solberg" },
  { id: "user-frieda", displayName: "Frieda Thal" },
  { id: "user-jan", displayName: "Jan Kessler" },
  { id: "user-ada", displayName: "Ada Renz" },
].map((user) => ({ ...user, uid: user.id, avatarHash: null, scope: "mailbox" as const, permission: "write" as const, description: "" }));

const tag = (id: string, name: string, color: string) => ({
  id,
  mailboxId: "Box001",
  name,
  color,
  revision: 1,
  createdAt: MAIL_V2_NOW,
  updatedAt: MAIL_V2_NOW,
});
const tags = {
  offer: tag("TagOffer", "Angebot", "#0f766e"),
  invoice: tag("TagInvoice", "Rechnung", "#b45309"),
  staff: tag("TagStaff", "Personal", "#7c3aed"),
};

type DemoRow = [from: string, subject: string, preview: string, minutes: number, overrides: Partial<MailListItem>];
const rows: DemoRow[] = [
  [
    "Holzwerk Brandt",
    "Angebot Eichenplatten – Liefertermin",
    "Guten Tag Frau Solberg, die Platten können wir in KW 49 liefern …",
    18,
    { messageCount: 3, unread: false, localTags: [tags.offer], attachmentCount: 2, assigneeUserIds: ["user-mira"], workStatus: "waiting" },
  ],
  [
    "Jonas Hartwig",
    "Frage zur Rechnung 2026-1184",
    "Hallo, auf der Rechnung steht ein anderer Betrag als im Angebot …",
    45,
    { localTags: [tags.invoice] },
  ],
  [
    "Stadtwerke Auental",
    "Zählerwechsel am 02.12.",
    "Sehr geehrte Damen und Herren, wir tauschen an diesem Tag …",
    70,
    { snoozedUntil: "2026-11-30T07:00:00.000Z" },
  ],
  [
    "Petra Lindqvist",
    "Küche Maß nehmen – Terminvorschlag",
    "Dienstag oder Donnerstag ab 16 Uhr würde bei uns passen …",
    DAY + 60,
    { messageCount: 2, unread: false, workStatus: "waiting", assigneeUserIds: ["user-frieda"] },
  ],
  [
    "Lackfabrik Nordhaus",
    "Preisliste 2027",
    "Anbei erhalten Sie unsere neue Preisliste, gültig ab 1. Januar …",
    DAY + 180,
    { attachmentCount: 1 },
  ],
  [
    "Architekturbüro Winter",
    "Re: Treppe Haus am Hang",
    "Danke für die Zeichnung. Wir brauchen noch die Höhe des …",
    2 * DAY + 60,
    {
      messageCount: 4,
      unread: false,
      assigneeUserIds: ["user-jan"],
      drafts: { count: 1, editors: [{ kind: "user", id: "user-jan", displayName: "Jan Kessler" }] },
    },
  ],
  ["Bauhof Nordtal", "Abholung Altholz", "Der Container steht ab Montag bereit, Abholung nach Anruf.", 2 * DAY + 120, { unread: false }],
  [
    "Familie Oswald",
    "Erinnerung: offenes Angebot Einbauschrank",
    "Das Angebot vom 02.11. läuft am 30.11. aus. Soll ich …",
    3 * DAY + 60,
    {
      unread: false,
      drafts: { count: 1, editors: [{ kind: "service_account", id: "sa-gustav", displayName: "Gustav" }], suggestedBy: "Gustav" },
    },
  ],
  [
    "Karla Oswald",
    "Bewerbung um einen Ausbildungsplatz",
    "Sehr geehrte Frau Renz, hiermit bewerbe ich mich …",
    4 * DAY + 60,
    { unread: false, localTags: [tags.staff], attachmentCount: 1, kept: true },
  ],
  ["Spedition Falk", "Lieferavis 4471", "Ihre Sendung wird am 23.11. zwischen 7 und 11 Uhr zugestellt.", 4 * DAY + 120, { unread: false }],
];

const body =
  "<p>Guten Tag Frau Solberg,</p><p>die 14 Platten können wir in KW 49 liefern, wenn die Bestellung bis Freitag bei uns ist. Der Preis aus dem Angebot bleibt bis dahin gültig. Die Lieferung kommt auf zwei Paletten, bitte halten Sie die Einfahrt frei.</p><p>Freundliche Grüße<br>Henrik Brandt</p>";

const message = (
  now: number,
  id: string,
  minutes: number,
  html: string,
  attachments: MailWorkspaceMessage["attachments"],
): MailWorkspaceMessage => ({
  id,
  subject: "Angebot Eichenplatten – Liefertermin",
  messageId: `<${id}@holzwerk-brandt.example>`,
  internalDate: minutesAgo(now, minutes),
  sentAt: minutesAgo(now, minutes),
  from: [{ name: "Holzwerk Brandt", address: "einkauf@holzwerk-brandt.example" }],
  to: [{ name: "Kontakt", address: "kontakt@solberg-kramer.example" }],
  preview: null,
  hasAttachments: attachments.length > 0,
  replyTo: [],
  cc: [],
  flags: ["\\Seen"],
  keywords: [],
  hydrationStatus: "complete",
  remoteAvailable: true,
  folderId: "Inbox1",
  deletedOnServer: false,
  contentType: "text/html",
  sizeBytes: html.length,
  plainText: html.replace(/<[^>]+>/g, " "),
  sanitizedHtml: html,
  selectedHeaders: {},
  sourceAvailable: true,
  mailingList: null,
  remoteContent: {
    imageIds: [],
    allowedByRule: false,
    allowRules: [],
    sender: "einkauf@holzwerk-brandt.example",
    domain: "holzwerk-brandt.example",
  },
  delivery: null,
  attachments,
});

/** The fixture's mailbox as the v2 mockup shows it: "Kontakt" with its folders, ten conversations, the first one open. */
export const mailV2Data = (url: URL, now: number): MailboxPageData => {
  // The mailbox sends as "Kontakt", so the reply names its sender.
  const source = new URL(url);
  source.searchParams.set("identity", "1");
  const base = mailboxData(source);
  const data = {
    ...base,
    identities: base.identities.map((identity) => ({
      ...identity,
      label: "Kontakt",
      displayName: "Kontakt",
      fromAddress: "kontakt@solberg-kramer.example",
    })),
  };
  const items = rows.map(([from, subject, preview, minutes, overrides], index) =>
    mailTestRow(`Demo${String(index + 1).padStart(2, "0")}`, {
      participantLabels: [from],
      participantSummary: from,
      subject,
      preview,
      latestMessageAt: minutesAgo(now, minutes),
      ...overrides,
    }),
  );
  const selected = url.searchParams.get("conversation");
  const open = selected === "Demo01";
  return {
    ...data,
    mailbox: { ...data.mailbox, name: "Kontakt" },
    folders: data.folders
      .filter((folder) => ["Inbox1", "Drafts1", "Sent1", "Filed1", "Long01"].includes(folder.id))
      .map((folder) => ({
        ...folder,
        name: folder.id === "Filed1" ? "Lieferanten" : folder.id === "Long01" ? "Reklamationen" : folder.name,
        unread: folder.id === "Inbox1" ? 7 : 0,
        total: folder.id === "Drafts1" ? 2 : folder.total,
      })),
    scheduledCount: 1,
    viewCounts: { ...data.viewCounts, needs_action: 5, mine: 3, waiting: 4 },
    listItems: items,
    nextListCursor: null,
    listError: null,
    doneTodayCounts: { doneToday: 12, doneByAutomation: 5 },
    assignableUsers: people,
    localTags: Object.values(tags),
    selectedSubject: open ? rows[0]![1] : data.selectedSubject,
    detailMessages: open
      ? [
          message(now, "DemoMsg1", 3 * DAY, "<p>Guten Tag,</p><p>wir brauchen 14 Eichenplatten, 40 mm, bis Mitte Dezember.</p>", []),
          message(now, "DemoMsg2", 2 * DAY, "<p>Guten Tag Frau Solberg,</p><p>das Angebot liegt bei.</p>", []),
          message(now, "DemoMsg3", 18, body, [
            {
              id: "DemoAtt1",
              filename: "Angebot-4471.pdf",
              contentType: "application/pdf",
              sizeBytes: 217_088,
              contentId: null,
              checksum: null,
            },
            {
              id: "DemoAtt2",
              filename: "Lieferbedingungen.pdf",
              contentType: "application/pdf",
              sizeBytes: 98_304,
              contentId: null,
              checksum: null,
            },
          ]),
        ]
      : data.detailMessages,
    conversationSummary: open
      ? summaryState({
          summary: "Brandt liefert 14 Eichenplatten in KW 49, wenn bis Freitag bestellt wird. Offen ist nur, ob die Kanten geölt kommen.",
          source: "workflow",
          ai: true,
        })
      : data.conversationSummary,
    collaborationState: open
      ? {
          conversationId: "Demo01",
          assignees: [people[0]!],
          workStatus: "waiting",
          snoozedUntil: null,
          revision: 1,
        }
      : data.collaborationState,
    conversationLocalTags: open ? { conversationId: "Demo01", conversationRevision: 1, tags: [tags.offer] } : data.conversationLocalTags,
    comments: open
      ? [
          {
            id: "DemoNote1",
            conversationId: "Demo01",
            body: "Brandt war bei der letzten Lieferung zwei Tage zu spät. Bitte Termin schriftlich bestätigen lassen.",
            author: { kind: "user" as const, id: "user-ada", displayName: "Ada Renz", avatarHash: null },
            referencedMessageId: null,
            revision: 1,
            canEdit: false,
            canDelete: false,
            editedAt: null,
            deletedAt: null,
            createdAt: minutesAgo(now, DAY - 6 * 60 + 2),
            updatedAt: minutesAgo(now, DAY - 6 * 60 + 2),
          },
        ]
      : data.comments,
  };
};

const v2Sidebar = {
  ...sidebar,
  mailboxes: sidebar.mailboxes.map((box, index) => ({
    ...box,
    name: ["Kontakt", "Rechnungen", "Personal", "Mira Solberg", "Archiv 2024"][index] ?? box.name,
  })),
  pinnedMailboxIds: ["Box001"],
};

export default function MailV2Fixture(props: { source: string; locale?: "en" | "de"; now: number; cookieHeader?: string | null }) {
  const url = new URL(props.source, "http://mail.example.test");
  const locale = props.locale ?? "de";
  const data = mailV2Data(url, props.now);
  return (
    <LocaleProvider locale={locale}>
      <MailWorkspace
        ui="v2"
        now={new Date(props.now).toISOString()}
        data={data}
        requestPath={props.source}
        currentUserId="user-mira"
        currentUserEmail="mira@solberg-kramer.example"
        contactDirectory={DEFAULT_MAIL_CONTACT_DIRECTORY}
        cloudUrl="https://cloud.example"
        dateConfig={{ locale, timeZone: "UTC" }}
        initialPreferences={readMailWorkspacePreferences(props.cookieHeader ?? "")}
        initialUserPreferences={readMailUserPreferencesFromCookieHeader("", data.mailbox.id)}
        initialTheme="light"
        calendarIntegrationAvailable={false}
        sidebar={v2Sidebar}
      />
    </LocaleProvider>
  );
}
