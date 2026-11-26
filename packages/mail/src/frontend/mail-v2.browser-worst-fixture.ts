import type { ConversationPresenceParticipant } from "../service/presence";
import type { MailboxPageData, MailListItem, MailWorkspaceMessage } from "../service/workspace";
import { mailTestRow } from "./_components/mail-list-test-fixtures";
import { summaryState } from "./_components/mail-summary-fixtures";

/*
 * The worst realistic data for Mail's v2 pilot (break-ui), as a state of the v2 browser harness only: `?fixture=worst`,
 * `empty`, `one` or `huge` (1,000 rows); `demo` or no value is the mockup's data. Every value is invented, plausible,
 * or the longest one Mail's contracts accept (the limit stands beside it). It never reaches the shipped app.
 */

export const MAIL_V2_FIXTURES = ["demo", "worst", "empty", "one", "huge"] as const;
export type MailV2FixtureState = (typeof MAIL_V2_FIXTURES)[number];
export const readMailV2Fixture = (value: string | null | undefined): MailV2FixtureState =>
  (MAIL_V2_FIXTURES as readonly string[]).includes(value ?? "") ? (value as MailV2FixtureState) : "demo";

const MINUTE = 60_000;
const DAY = 24 * 60;
const at = (now: number, minutes: number) => new Date(now - minutes * MINUTE).toISOString();

/** Mailbox name: the longest a person plausibly types (create limit 160, contracts.ts createMailboxInputSchema). */
export const WORST_MAILBOX = "Kundenservice Gewährleistung & Reklamationen – Tischlerei Solberg & Kramer GmbH & Co. KG, Niederlassung Süd";
/** Sender identity label (limit 200, contracts.ts senderIdentity label). */
const WORST_IDENTITY = "Kundenservice Gewährleistung & Reklamationen (Tischlerei Solberg & Kramer GmbH & Co. KG)";
const WORST_FROM = "kundenservice-gewaehrleistung@niederlassung-sued.solberg-kramer.example";
const LONG_EMAIL = "bartholomew.fitzgerald@northwind-industries-holdings.example.com";
const ALEKS = {
  name: "Aleksandra Wiśniewska-Kowalczyk",
  address: "aleksandra.wisniewska-kowalczyk@northwind-industries-holdings.example.com",
};

const user = (id: string, displayName: string) => ({
  id,
  uid: id,
  displayName,
  avatarHash: null,
  scope: "mailbox" as const,
  permission: "write" as const,
  description: "",
});
const people = {
  chris: user("user-chris", "Christopher Alexander Montgomery III"),
  priya: user("user-priya", "👩🏽‍💻 Priya"),
  hang: user("user-hang", "Đặng Thị Ngọc Hân"),
  j: user("user-j", "J"),
  spaces: user("user-sam", "  Sam   Lee "),
};

const tag = (id: string, name: string, color: string) => ({
  id,
  mailboxId: "Box001",
  name,
  color,
  revision: 1,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
});
/** Tag names: limit 80 (contracts.ts localTagNameSchema); a conversation may carry 50 (setConversationLocalTagsSchema). */
const tags = [
  tag("TagW01", "Reklamation Gewährleistung – Rückruf durch Geschäftsleitung bis Monatsende nötig", "#b91c1c"),
  tag("TagW02", "Benachrichtigungseinstellungen", "#0f766e"),
  tag("TagW03", "Rechnung", "#b45309"),
  tag("TagW04", "Angebot", "#0369a1"),
  tag("TagW05", "dringend", "#dc2626"),
  tag("TagW06", "Q4", "#4d7c0f"),
  tag("TagW07", "wartet auf Kunde", "#7c3aed"),
  tag("TagW08", "Montage", "#a16207"),
  tag("TagW09", "Nachtrag", "#be185d"),
  tag("TagW10", "Lieferant", "#0f766e"),
  tag("TagW11", "Architekt", "#475569"),
  tag("TagW12", "Steuerberater", "#1d4ed8"),
];

/** Saved view names: limit 120 (schema.sql saved_conversation_views_name_check); no limit on their number found. */
const savedViewNames = [
  "Rechnungen von Lieferanten mit offenem Zahlungsziel über 30 Tage – nur Großkunden der Region Süd, ohne Gutschriften",
  "Gewährleistungsfälle",
  "Kundendienstvereinbarungsänderungen",
  "Steuerberater & Buchhaltung (Quartalsabschluss)",
  "Bewerbungen",
  "Team Montage Süd",
  "Newsletter",
  "Ö",
];

const SUBJECT_LONG =
  "AW: AW: WG: Rückfrage zur Schlussrechnung Nr. 2026-004711 – Einbauschrank Dachgeschoss, Nachtrag Beschläge und Montage (bitte bis Freitag prüfen)";
const URL_LONG =
  "https://example.com/sendungsverfolgung/2026/11/DE-4471-0098-7731-5521?ref=mail&lang=de&utm_source=avis&utm_campaign=november";

type Row = [id: string, overrides: Partial<MailListItem>, minutes: number];
/** The first rows spread the failures, as real lists do; row 1 carries every mark at once and is the open one. */
const worstRows = (now: number): Row[] => [
  [
    "Worst01",
    {
      participantLabels: [ALEKS.name],
      participantSummary: ALEKS.name,
      subject: SUBJECT_LONG,
      preview:
        "Sehr geehrte Damen und Herren, leider müssen wir Ihnen mitteilen, dass die Schlussrechnung nicht mit dem Angebot vom 02.11. übereinstimmt und die Beschläge doppelt berechnet wurden …",
      messageCount: 128,
      localTags: tags,
      attachmentCount: 37,
      assigneeUserIds: [people.chris.id],
      workStatus: "waiting",
      drafts: { count: 1, editors: [{ kind: "service_account", id: "sa-gustav", displayName: "Gustav" }], suggestedBy: "Gustav" },
      kept: true,
      snoozedUntil: new Date(now + 3 * DAY * MINUTE).toISOString(),
    },
    1,
  ],
  [
    "Worst02",
    {
      participantLabels: [],
      participantSummary: LONG_EMAIL,
      subject: "Lieferavis",
      preview: URL_LONG,
      messageCount: 2,
      localTags: [tags[1]!],
      attachmentCount: 1,
    },
    9,
  ],
  ["Worst03", { participantLabels: ["Jo"], participantSummary: "Jo", subject: "", preview: null, unread: false }, 3 * DAY],
  [
    "Worst04",
    {
      participantLabels: ["王秀英"],
      participantSummary: "王秀英",
      subject: "关于厨房橱柜订单的交货时间问题",
      preview: "您好，请问我们订购的橱柜什么时候可以送到？我们下周需要安装，谢谢！",
      messageCount: 2,
    },
    47,
  ],
  [
    "Worst05",
    {
      participantLabels: ["Đặng Thị Ngọc Hân"],
      participantSummary: "Đặng Thị Ngọc Hân",
      subject: "Bảng báo giá – Tủ bếp gỗ sồi (bản cập nhật lần thứ ba)",
      preview: "Kính gửi Quý công ty, chúng tôi gửi kèm bảng báo giá đã cập nhật …",
      assigneeUserIds: [people.hang.id],
      unread: false,
    },
    DAY + 30,
  ],
  [
    "Worst06",
    {
      participantLabels: ["🦊 Fox"],
      participantSummary: "🦊 Fox",
      subject: "👩🏽‍💻 Neue Website – Feedback 🎉🎉🎉",
      preview: "😀😀😀",
      assigneeUserIds: [people.priya.id],
      drafts: { count: 2, editors: [{ kind: "user", id: people.priya.id, displayName: people.priya.displayName }] },
    },
    DAY + 90,
  ],
  [
    "Worst07",
    {
      participantLabels: ["Seán O'Brien-Ó Súilleabháin"],
      participantSummary: "Seán O'Brien-Ó Súilleabháin",
      subject: "<script>alert(1)</script> &amp; **dringend**: Angebot",
      preview: "Zeile eins\nZeile zwei\n\nGruß",
      unread: false,
    },
    2 * DAY,
  ],
  [
    "Worst08",
    {
      participantLabels: ["Konstantin Oberhauser-Wettstein"],
      participantSummary: "Konstantin Oberhauser-Wettstein",
      subject: "Kundendienstvereinbarungsänderungsbenachrichtigung",
      preview: "Kundendienstvereinbarungsänderungsbenachrichtigungsverfahrensbeschreibung",
      drafts: { count: 1, editors: [{ kind: "user", id: people.chris.id, displayName: people.chris.displayName }] },
      unread: false,
    },
    2 * DAY + 60,
  ],
  // A clock that runs fast at the sender: the newest mail is dated in the future.
  ["Worst09", { participantLabels: ["J"], participantSummary: "J", subject: "?", preview: "?", messageCount: 99 }, -3 * DAY],
  [
    "Worst10",
    { participantLabels: ["  Sam   Lee "], participantSummary: "  Sam   Lee ", subject: "Termin", preview: "Passt", unread: false },
    3 * 365 * DAY,
  ],
  [
    "Worst11",
    {
      participantLabels: ["María José de la Cruz y Fernández"],
      participantSummary: "María José de la Cruz y Fernández",
      subject: "Re: Re: Re: Re: Re: Re: Re: Treppe Haus am Hang",
      preview: "Danke!",
      workStatus: "done",
      unread: false,
    },
    5 * DAY,
  ],
  [
    "Worst12",
    {
      participantLabels: ["Lackfabrik Nordhaus Vertriebsgesellschaft mbH & Co. KG – Kundenservice Region Süd"],
      participantSummary: "Lackfabrik Nordhaus Vertriebsgesellschaft mbH & Co. KG – Kundenservice Region Süd",
      subject: "Preisliste 2027",
      preview: "Anbei erhalten Sie unsere neue Preisliste.",
      attachmentCount: 1_284,
      unread: false,
    },
    6 * DAY,
  ],
];

const address = (name: string, mail: string) => ({ name, address: mail });
/** Fourteen recipients: a team distribution that writes every address out. */
const crowd = [
  address("Christopher Alexander Montgomery III", "christopher.montgomery@northwind-industries-holdings.example.com"),
  address("Konstantin Oberhauser-Wettstein", "k.oberhauser-wettstein@example.org"),
  address("", "einkauf@example.org"),
  address("María José de la Cruz y Fernández", "mariajose@example.org"),
  address("Jo", "jo@example.org"),
  address("王秀英", "wang.xiuying@example.org"),
  address("Đặng Thị Ngọc Hân", "hang@example.org"),
  address("Seán O'Brien-Ó Súilleabháin", "sean@example.org"),
  address("", "first.last+billing-notifications@example.com"),
  address("Buchhaltung", "ops@sub.department.region.example.test"),
  address("Team Montage Süd", "montage-sued@example.org"),
  address("Geschäftsleitung", "gl@example.org"),
  address("J", "j@example.org"),
  address("🦊 Fox", "fox@example.org"),
];

/** Filenames: limit 255 (schema.sql attachment_links_filename_check); one has none; sizes 0 B to 100 MB (byte_length check). */
const attachmentsWorst: MailWorkspaceMessage["attachments"] = [
  [
    "Angebot_4471_Einbauschrank_Dachgeschoss_Nachtrag_Beschläge_und_Montage_final_final_v12_unterschrieben_Kunde_und_Geschäftsleitung.pdf",
    "application/pdf",
    217_088,
  ],
  ["IMG_20251114_183022_HDR_portrait_edited_edited.HEIC", "image/heic", 4_718_592],
  [
    "Q3 Board Deck — FINAL (revised) v12 [approved by legal].pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    104_857_600,
  ],
  [null, "application/octet-stream", 0],
  ["a.txt", "text/plain", 1],
  ["Lieferbedingungen.pdf", "application/pdf", 98_304],
  ["Aufmaß Küche Ostflügel.dwg", "application/acad", 12_582_912],
  ["Rechnung-2026-004711.pdf", "application/pdf", 88_000],
  ["Rechnung-2026-004711 (1).pdf", "application/pdf", 88_000],
  ["Rechnung-2026-004711 (2).pdf", "application/pdf", 88_000],
  ["Foto 1.jpg", "image/jpeg", 2_100_000],
  ["Foto 2.jpg", "image/jpeg", 2_200_000],
  ["Foto 3.jpg", "image/jpeg", 2_300_000],
  [
    "Kundendienstvereinbarungsänderungsbenachrichtigung.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    40_960,
  ],
].map(([filename, contentType, sizeBytes], index) => ({
  id: `WorstAtt${String(index + 1).padStart(2, "0")}`,
  filename: filename as string | null,
  contentType: contentType as string,
  sizeBytes: sizeBytes as number,
  contentId: null,
  checksum: null,
}));

const message = (
  now: number,
  id: string,
  minutes: number,
  from: { name: string; address: string },
  options: {
    html?: string | null;
    plain?: string;
    to?: { name: string; address: string }[];
    cc?: { name: string; address: string }[];
    replyTo?: { name: string; address: string }[];
    subject?: string;
    attachments?: MailWorkspaceMessage["attachments"];
  },
): MailWorkspaceMessage => {
  const html = options.html ?? null;
  const plain = options.plain ?? (html ? html.replace(/<[^>]+>/g, " ") : "");
  const attachments = options.attachments ?? [];
  return {
    id,
    subject: options.subject ?? SUBJECT_LONG,
    messageId: `<${id}@example.org>`,
    internalDate: at(now, minutes),
    sentAt: at(now, minutes),
    from: [from],
    to: options.to ?? [address("Kundenservice", WORST_FROM)],
    preview: null,
    hasAttachments: attachments.length > 0,
    replyTo: options.replyTo ?? [],
    cc: options.cc ?? [],
    flags: ["\\Seen"],
    keywords: [],
    hydrationStatus: "complete",
    remoteAvailable: true,
    folderId: "Inbox1",
    deletedOnServer: false,
    contentType: html ? "text/html" : "text/plain",
    sizeBytes: (html ?? plain).length,
    plainText: plain,
    sanitizedHtml: html,
    selectedHeaders: {},
    sourceAvailable: true,
    mailingList: null,
    remoteContent: { imageIds: [], allowedByRule: false, allowRules: [], sender: from.address, domain: from.address.split("@")[1] ?? "" },
    delivery: null,
    attachments,
  };
};

/** The reply's draft in the worst case: the latest message's reply addresses, with three people in copy. */
export const worstReplyTo = {
  to: [ALEKS, address("Christopher Alexander Montgomery III", crowd[0]!.address), address("", LONG_EMAIL)],
  cc: crowd.slice(1, 4),
};

/** A newsletter-like HTML mail: a fixed 900 px table and a link with no break opportunity. */
const WIDE_HTML = `<p>Sehr geehrte Damen und Herren,</p><p>die Sendungsverfolgung: <a href="${URL_LONG}">${URL_LONG}</a></p><table width="900" style="width:900px;border-collapse:collapse"><tr><td style="width:300px">Position</td><td style="width:300px">Menge</td><td style="width:300px">Betrag</td></tr><tr><td>Beschläge Edelstahl gebürstet</td><td>1.284</td><td>12.345.678,90 €</td></tr></table><p>Kundendienstvereinbarungsänderungsbenachrichtigungsverfahrensbeschreibung</p><p>Mit freundlichen Grüßen<br>Aleksandra Wiśniewska-Kowalczyk</p>`;

const PLAIN_LONG = [
  "Hallo Frau Wiśniewska-Kowalczyk,",
  "",
  "danke für Ihre Nachricht. Ich habe die Schlussrechnung mit dem Angebot verglichen: Die Beschläge stehen tatsächlich zweimal drin, einmal unter Position 14 und einmal im Nachtrag vom 12.11. Wir schicken Ihnen bis Freitag eine korrigierte Rechnung.",
  "",
  "> Am 20.11.2026 schrieb Aleksandra Wiśniewska-Kowalczyk:",
  "> Sehr geehrte Damen und Herren, leider müssen wir Ihnen mitteilen …",
  "",
  "Viele Grüße",
  "Kundenservice",
].join("\n");

/** An internal note pasted from a phone call log (limit 50,000, contracts.ts internalCommentBodySchema). */
const NOTE_LONG = [
  "Telefonat mit Frau Wiśniewska-Kowalczyk am 24.11., 16:40 Uhr (Dauer 23 min):",
  "",
  "1. Sie besteht auf schriftlicher Bestätigung des Liefertermins, die letzte Lieferung kam zwei Tage zu spät.",
  "2. Die Beschläge wurden laut Kundin doppelt berechnet (Position 14 und Nachtrag). Bitte mit der Buchhaltung klären.",
  "3. Rückruf durch die Geschäftsleitung bis Monatsende gewünscht, sonst Anwalt.",
  "",
  `Unterlagen liegen hier: ${URL_LONG}`,
  "",
  "Kundendienstvereinbarungsänderungsbenachrichtigungsverfahrensbeschreibung liegt bei der GL.",
  "",
  ...Array.from(
    { length: 6 },
    (_, index) =>
      `Nachtrag ${index + 1}: Die Kundin hat erneut angerufen und nach dem Stand gefragt; ich habe auf die schriftliche Antwort bis Freitag verwiesen und notiert, dass sie die Montage im Dachgeschoss nicht vor dem 15.12. freigeben will.`,
  ),
].join("\n");

/** Short summary at its limit: 1,000 characters (conversation-summary-ai.ts OUTPUT_CHARS.short). */
const SUMMARY_LONG = (() => {
  const text =
    "Frau Wiśniewska-Kowalczyk reklamiert die Schlussrechnung Nr. 2026-004711: Die Beschläge seien doppelt berechnet (Position 14 und Nachtrag vom 12.11.), der Liefertermin der letzten Lieferung wurde um zwei Tage überschritten. Sie verlangt eine schriftliche Bestätigung des neuen Liefertermins in KW 49, eine korrigierte Rechnung bis Freitag und einen Rückruf durch die Geschäftsleitung bis Monatsende; andernfalls will sie einen Anwalt einschalten. Bartholomew Fitzgerald von Northwind hat die Sendungsverfolgung geschickt, die Lieferung steht auf zwei Paletten bereit. Intern hat Christopher Montgomery die Buchhaltung gebeten, Position 14 zu prüfen. Offen sind: wer die Rechnung korrigiert, ob die Montage im Dachgeschoss vor dem 15.12. freigegeben wird, und ob die Kanten geölt oder lackiert geliefert werden. Nächster Schritt: Rechnung korrigieren, Termin schriftlich bestätigen, Rückruf der Geschäftsleitung einplanen. ";
  return (text + text).slice(0, 1_000).trimEnd();
})();

const detail = (now: number, state: MailV2FixtureState, id: string, row: MailListItem | undefined) => {
  if (state === "one")
    return [
      message(now, "WorstMsg1", 18, ALEKS, {
        html: "<p>Guten Tag,</p><p>anbei das Angebot.</p>",
        subject: row?.subject,
        attachments: [attachmentsWorst[5]!],
      }),
    ];
  if (id !== "Worst01") {
    const sender = row?.participantLabels[0] ?? "";
    return [
      message(
        now,
        `${id}Msg1`,
        60,
        { name: sender, address: row?.participantLabels.length ? "absender@example.org" : LONG_EMAIL },
        {
          plain: row?.preview ?? "",
          subject: row?.subject ?? "",
        },
      ),
    ];
  }
  return [
    message(now, "WorstMsg1", 3 * DAY, ALEKS, { html: WIDE_HTML, to: crowd, cc: crowd.slice(0, 3), attachments: attachmentsWorst }),
    message(now, "WorstMsg2", 2 * DAY, { name: "Kundenservice", address: WORST_FROM }, { plain: PLAIN_LONG, to: [ALEKS] }),
    message(
      now,
      "WorstMsg3",
      1,
      { name: "", address: LONG_EMAIL },
      {
        html: "<p>Die Sendung ist unterwegs.</p>",
        replyTo: worstReplyTo.to,
        attachments: [attachmentsWorst[1]!],
      },
    ),
  ];
};

const comment = (now: number, id: string, minutes: number, author: { id: string; displayName: string }, body: string | null) => ({
  id,
  conversationId: "Worst01",
  body,
  author: { kind: "user" as const, id: author.id, displayName: author.displayName, avatarHash: null },
  referencedMessageId: null,
  revision: 1,
  canEdit: false,
  canDelete: false,
  editedAt: null,
  deletedAt: body === null ? at(now, minutes - 5) : null,
  createdAt: at(now, minutes),
  updatedAt: at(now, minutes),
});

/** Who reads along in the worst case: five people (presence keeps up to 250 entries, service/presence.ts). */
export const worstPresence = (state: MailV2FixtureState, now: number): ConversationPresenceParticipant[] => {
  const names =
    state === "worst"
      ? [people.chris, people.priya, people.hang, people.j, people.spaces]
      : state === "one"
        ? [people.chris]
        : state === "huge"
          ? [people.j]
          : [];
  return names.map((person, index) => ({
    userId: person.id,
    displayName: person.displayName,
    avatarHash: null,
    mode: index === 0 ? "composing" : "viewing",
    peerCount: 1,
    joinedAt: at(now, index + 1),
  }));
};

/** The title of a linked task at worst: long, with names and numbers (invented data, not a text of the UI). */
const TASK = "Aufgabe";
const WORST_TASK_TITLE = "Schlussrechnung 2026-004711 korrigieren und an Frau Wiśniewska-Kowalczyk schicken (Position 14 doppelt)";

/** What other apps linked: fourteen tasks with long titles in the worst case (spaces context, no limit found). */
export const worstLinked = (state: MailV2FixtureState) => {
  const count = state === "worst" ? 14 : state === "one" ? 1 : 0;
  return Array.from({ length: count }, (_, index) => ({
    ref: { app: "spaces", type: "task", id: `WorstTask${index + 1}` },
    title: index === 0 ? WORST_TASK_TITLE : `${TASK} ${index + 1}`,
    icon: "ti ti-checkbox",
    links: [{ rel: "open", href: `/app/spaces/tasks/WorstTask${index + 1}` }],
  }));
};

/** The sidebar's mailboxes in each state: long, short and compound names (limit 160). */
export const worstMailboxNames = (state: MailV2FixtureState): string[] | null =>
  state === "demo"
    ? null
    : [
        WORST_MAILBOX,
        "IT",
        "Kundendienstvereinbarungsänderungen",
        "Aleksandra Wiśniewska-Kowalczyk (persönlich, bitte nicht für Kundenanfragen verwenden)",
        "Archiv 2024",
      ];

/** Replaces the demo's data with the state's: the same page shape, only the values change (break-ui Hard Rule 2). */
export const applyMailV2Fixture = (data: MailboxPageData, url: URL, now: number): MailboxPageData => {
  const state = readMailV2Fixture(url.searchParams.get("fixture"));
  if (state === "demo") return data;
  const base = worstRows(now).map(([id, overrides, minutes]) => mailTestRow(id, { latestMessageAt: at(now, minutes), ...overrides }));
  const rows: MailListItem[] =
    state === "empty"
      ? []
      : state === "one"
        ? [{ ...base[0]!, messageCount: 1, attachmentCount: 1, localTags: [tags[3]!], drafts: { count: 0, editors: [] }, kept: false }]
        : state === "huge"
          ? Array.from({ length: 1_000 }, (_, index) => {
              const source = base[index % base.length]!;
              const id = `Huge${String(index + 1).padStart(4, "0")}`;
              return { ...source, id, conversationId: id, latestMessageAt: at(now, index * 7) };
            })
          : base;
  const count = (worst: number) => (state === "empty" ? 0 : state === "one" ? 1 : worst);
  const selected = url.searchParams.get("conversation");
  const row = rows.find((item) => item.conversationId === selected);
  const open = Boolean(row);
  const savedViews = (state === "empty" ? [] : state === "one" ? savedViewNames.slice(0, 1) : savedViewNames).map((name, index) => ({
    ...data.savedViews[0]!,
    id: `Saved${index + 1}`,
    name,
  }));
  return {
    ...data,
    mailbox: { ...data.mailbox, name: WORST_MAILBOX },
    identities: data.identities.map((identity) => ({
      ...identity,
      label: WORST_IDENTITY,
      displayName: WORST_IDENTITY,
      fromAddress: WORST_FROM,
    })),
    listTitle: savedViews.find((view) => view.id === url.searchParams.get("savedView"))?.name ?? data.listTitle,
    savedViews,
    folders: data.folders.map((folder) => ({
      ...folder,
      name:
        folder.id === "Filed1"
          ? "Lieferanten und Subunternehmer (Rahmenverträge 2025–2027)"
          : folder.id === "Long01"
            ? "Kundendienstvereinbarungsänderungsbenachrichtigungen"
            : folder.name,
      unread: folder.role === "inbox" ? count(12_847) : folder.id === "Filed1" ? count(999) : 0,
      total: folder.role === "drafts" ? count(1_284) : folder.total,
    })),
    scheduledCount: count(1_284),
    viewCounts: {
      ...data.viewCounts,
      needs_action: count(12_847),
      mine: count(1_284),
      waiting: count(307),
      unassigned: count(9_999),
      done: count(184_302),
      snoozed: count(1),
      send_problems: count(1),
      recently_active: count(12_847),
      kept: count(0),
    },
    listItems: rows,
    // The worst page has more behind it; "huge" is 1,000 rows loaded at once, as after many "Weitere laden".
    nextListCursor: state === "worst" ? "WorstCursor2" : null,
    listError: null,
    doneTodayCounts: { doneToday: count(1_284), doneByAutomation: state === "empty" ? 0 : 1 },
    assignableUsers: Object.values(people),
    localTags: tags,
    selectedSubject: open ? row!.subject : data.selectedSubject,
    detailMessages: open ? detail(now, state, row!.conversationId!, row) : data.detailMessages,
    conversationSummary: open
      ? summaryState({ summary: state === "one" ? "Kurz." : SUMMARY_LONG, source: "workflow", ai: true })
      : data.conversationSummary,
    collaborationState: open
      ? {
          conversationId: row!.conversationId!,
          assignees: state === "one" ? [people.j] : [people.chris],
          workStatus: row!.workStatus ?? "needs_action",
          snoozedUntil: row!.snoozedUntil,
          revision: 1,
        }
      : data.collaborationState,
    conversationLocalTags: open
      ? { conversationId: row!.conversationId!, conversationRevision: 1, tags: row!.localTags }
      : data.conversationLocalTags,
    comments: open
      ? state === "one"
        ? [comment(now, "WorstNote1", 30, people.j, "Ok.")]
        : row!.conversationId === "Worst01"
          ? [comment(now, "WorstNote1", DAY, people.chris, NOTE_LONG), comment(now, "WorstNote2", 2 * DAY + 10, people.priya, null)]
          : []
      : data.comments,
  };
};
