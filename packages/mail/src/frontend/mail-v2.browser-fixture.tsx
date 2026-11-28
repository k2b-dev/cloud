import { LocaleProvider } from "@k2b/ui";
import { DEFAULT_MAIL_CONTACT_DIRECTORY } from "../contact-directory-settings";
import type { MailboxPageData, MailListItem, MailWorkspaceMessage } from "../service/workspace";
import { mailConversationUiMessages } from "./_components/mail-conversation-ui-messages";
import { mailTestRow } from "./_components/mail-list-test-fixtures";
import { summaryState } from "./_components/mail-summary-fixtures";
import { readMailUserPreferencesFromCookieHeader } from "./_components/mail-user-preferences";
import { readMailWorkspacePreferences } from "./_components/mail-workspace-preferences";
import { MailDraftReviewChangedV2, MailDraftReviewV2 } from "./MailDraftReviewV2";
import MailWorkspacePilot from "./MailWorkspaceV2.island";
import { mailboxData, sidebar } from "./mail-shell.browser-fixture";
import { MAIL_V2_NOW } from "./mail-v2.browser-clock";
import { mailPageMessages } from "./pages-messages";

/*
 * Mail's mailbox on the v2 pilot with the invented conversations of the approved v2 mockup (mail.html): the real
 * island, controller and SSR, only the data is made up. The tests freeze the clock at `MAIL_V2_NOW`.
 */

const minutesAgo = (now: number, minutes: number) => new Date(now - minutes * 60_000).toISOString();
const DAY = 24 * 60;
/** The demo's signature, as the mockup shows it under the reply. */
export const MAIL_V2_SIGNATURE = { id: "DemoSig1", name: "Kontakt", text: "Mira Solberg\nTischlerei Solberg & Kramer" };

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

const listErrors = ["invalid_search", "search_failed", "load_failed"] as const;
const listError = (url: URL) => listErrors.find((code) => code === url.searchParams.get("listError")) ?? null;

const savedViewNames: Record<string, string> = { "Priority view": "Wichtig", "Team view": "Team" };

/**
 * The mails received per day of the last 371 days, as the reader shows them while none is open: quiet weekends, busy
 * Mondays, a few days off and one day of a newsletter flood, fixed by the day (no randomness). `?received=none` is a
 * new mailbox without mail, `?received=huge` one with thousands a day.
 */
export const mailV2ReceivedPerDay = (url: URL, now: number): NonNullable<MailboxPageData["receivedPerDay"]> => {
  const today = new Date(now).toISOString().slice(0, 10);
  const shape = url.searchParams.get("received");
  if (shape === "none") return { today, days: [] };
  const days = Array.from({ length: 371 }, (_, back) => {
    const date = new Date(now - (370 - back) * DAY * 60_000);
    const weekday = (date.getUTCDay() + 6) % 7;
    const index = Math.floor(date.getTime() / (DAY * 60_000));
    const count =
      weekday >= 5
        ? index % 5 === 0
          ? 1
          : 0
        : index % 29 === 0
          ? 0
          : index % 97 === 0
            ? 160
            : ((index * 37) % 11) + (weekday === 0 ? 6 : 1);
    const all = shape === "huge" ? count * 1234 : count;
    // about six in ten came in, the rest went out
    const incoming = Math.ceil(all * 0.6);
    return { date: date.toISOString().slice(0, 10), incoming, sent: all - incoming };
  });
  return { today, days: days.filter((day) => day.incoming + day.sent > 0) };
};

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
      // The mailbox's signature for this sender (the server renders it, see mail-v2.browser-server.ts).
      defaultSignatureTemplateId: MAIL_V2_SIGNATURE.id,
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
  const german = url.searchParams.get("locale") !== "en";
  const selected = url.searchParams.get("conversation");
  const open = selected === "Demo01";
  return {
    ...data,
    mailbox: { ...data.mailbox, name: "Kontakt" },
    // The server names the list in the page's language (service/workspace.ts: the mailbox's start, without a folder, is
    // "Alle E-Mails"); the shared fixture's is English.
    listTitle: german
      ? (savedViewNames[data.listTitle] ?? (data.listTitle === "All mail" ? "Alle E-Mails" : data.listTitle))
      : data.listTitle,
    // The shared fixture's saved views are English; the German page names them in German.
    savedViews: german ? data.savedViews.map((view) => ({ ...view, name: savedViewNames[view.name] ?? view.name })) : data.savedViews,
    folders: data.folders
      .filter((folder) => ["Inbox1", "Drafts1", "Sent1", "Archive1", "Trash1", "Junk1", "Filed1", "Long01"].includes(folder.id))
      .map((folder) => ({
        ...folder,
        name: folder.id === "Filed1" ? "Lieferanten" : folder.id === "Long01" ? "Reklamationen" : folder.name,
        unread: folder.id === "Inbox1" ? 7 : 0, // the mockup counts only the inbox
        total: folder.id === "Drafts1" ? 2 : folder.total,
      })),
    scheduledCount: 1,
    viewCounts: { ...data.viewCounts, needs_action: 5, mine: 3, waiting: 4 },
    // `?listError=<code>`: the list as the server answers a failed load; a search that is not valid brings no rows
    listItems: listError(url) === "invalid_search" ? [] : items,
    nextListCursor: null,
    listError: listError(url),
    doneTodayCounts: { doneToday: 12, doneByAutomation: 5 },
    // as Mail's page: only a page that opens no mail brings the year of mail
    receivedPerDay: url.searchParams.has("conversation") ? null : mailV2ReceivedPerDay(url, now),
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

export default function MailV2Fixture(props: {
  source: string;
  locale?: "en" | "de";
  now: number;
  cookieHeader?: string | null;
  /** The fixture server's own origin, which serves the shared typeface. */
  cloudUrl?: string;
}) {
  const url = new URL(props.source, "http://mail.example.test");
  const locale = props.locale ?? "de";
  // `?review=read|changed`: a draft as a review link shows it (read only), and a review whose version is gone
  const review = url.searchParams.get("review");
  const place = { mailbox: { name: "Kontakt", href: "/app/mail/Box001" }, subject: "Re: Treppe Haus am Hang" };
  const pages = mailPageMessages.resolve([locale]).t;
  const conversationText = mailConversationUiMessages.resolve([locale]).t;
  if (review === "changed")
    return (
      <LocaleProvider locale={locale}>
        <MailDraftReviewChangedV2
          {...place}
          title={pages.reviewChanged}
          description={pages.reviewChangedDescription}
          current={{ label: pages.openCurrentDraft, href: "/app/mail/Box001/drafts/Drf001" }}
        />
      </LocaleProvider>
    );
  if (review === "read")
    return (
      <LocaleProvider locale={locale}>
        <MailDraftReviewV2
          {...place}
          note={pages.draftReadOnly}
          facts={[
            { label: "An", value: "Architekturbüro Winter <planung@architektur-winter.example>" },
            { label: "Cc", value: "Jan Kroll <jan@solberg-kramer.example>" },
          ]}
          body={{
            format: "markdown",
            text: "Hallo Herr Winter,\n\ndie Stufenhöhe beträgt **17,8 cm** bei 16 Stufen. Die Zeichnung mit den Maßen hängt an.\n\n- Lauflänge 3,40 m\n- Handlauf beidseitig\n\nViele Grüße\nJan Kroll",
          }}
          attachments={["Treppe-Hang-v3.pdf", "Stufenplan.png"]}
          text={{ attachments: conversationText.attachments, noMessageBody: conversationText.noMessageBody }}
        />
      </LocaleProvider>
    );
  const data = mailV2Data(url, props.now);
  return (
    <LocaleProvider locale={locale}>
      <MailWorkspacePilot
        now={new Date(props.now).toISOString()}
        data={data}
        requestPath={props.source}
        currentUserId="user-mira"
        currentUserEmail="mira@solberg-kramer.example"
        contactDirectory={DEFAULT_MAIL_CONTACT_DIRECTORY}
        cloudUrl={props.cloudUrl ?? "https://cloud.example"}
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
