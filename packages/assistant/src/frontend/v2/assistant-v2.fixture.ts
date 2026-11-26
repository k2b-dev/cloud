import type { AiConversation, AiProject, AiStoredMessage } from "@k2b/cloud/ai";

/**
 * Invented data for the Assistant's v2 screens: one person's chats over a month, Projects, chats at places, done
 * chats and one open conversation. `worst` stretches every name and count, `huge` holds 1,000 chats, `empty` none.
 */
export type AssistantV2FixtureState = "usual" | "worst" | "huge" | "empty";

export const FIXTURE_NOW = "2026-11-26T09:30:00.000Z";
const now = Date.parse(FIXTURE_NOW);
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

const chat = (id: string, title: string, minutesAgo: number, patch: Partial<AiConversation> = {}): AiConversation => ({
  id,
  shortId: id,
  title,
  titleSource: "user",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: at(minutesAgo),
  archivedAt: null,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: "user-mira",
  createdAt: at(minutesAgo + 30),
  updatedAt: at(minutesAgo),
  ...patch,
});

const project = (id: string, name: string, icon: string, description: string): AiProject => ({
  id,
  shortId: id,
  name,
  description,
  icon,
  instructions: "",
  defaultModel: null,
  permission: "admin",
  revision: 1,
  createdAt: at(40_000),
  updatedAt: at(2_000),
});

export const FIXTURE_PROJECTS: AiProject[] = [
  project("Prj01", "Werkstatt Angebote", "ti ti-hammer", "Angebote und Aufmaße der Werkstatt"),
  project("Prj02", "Küche Lindqvist", "ti ti-tools-kitchen-2", "Planung und Abstimmung mit der Kundin"),
  project("Prj03", "Buchhaltung 2026", "ti ti-receipt", "Belege, Mahnungen und Monatsabschluss"),
  project("Prj04", "Messe Frühjahr", "ti ti-presentation", "Stand, Material und Termine"),
];

const USUAL: AiConversation[] = [
  chat("Pin001", "Wochenplan Werkstatt", 15, { pinnedAt: at(9_000) }),
  chat("Pin002", "Preisliste Ersatzteile pflegen", 4_000, { pinnedAt: at(20_000) }),
  chat("Tod001", "Angebot Küche Lindqvist nachrechnen", 3, {
    runStatus: "running",
    projectId: "Prj02",
    activity: { completed: 2, total: 5, step: "Liest das Aufmaß", tool: "files.read" },
  }),
  chat("Tod002", "Mail an Bad Oswald wegen Lieferzeit", 24, { runStatus: "needs_attention" }),
  chat("Tod003", "Rechnung 2026-118 prüfen", 52, { unreadCompletion: true, projectId: "Prj03" }),
  chat("Tod004", "Zusammenfassung Kundentermin Winter", 95, { unreadCompletion: true }),
  chat("Tod005", "Materialliste Treppe als Tabelle", 160),
  chat("Yes001", "Urlaubsplanung Dezember", 1_500),
  chat("Yes002", "Fehler im Export der Lagerliste", 1_620, { runStatus: "failed" }),
  chat("Yes003", "Text für die Website: Über uns", 1_700),
  chat("Yes004", "Mahnung an Kunde Berger formulieren", 1_900, { projectId: "Prj03" }),
  chat("Wee001", "Messestand: Material bestellen", 3_100, { projectId: "Prj04" }),
  chat("Wee002", "Schichtplan Januar entwerfen", 4_400),
  chat("Wee003", "Lieferanten für Kantenband vergleichen", 5_200),
  chat("Wee004", "Protokoll Teamrunde 18.11.", 7_000),
  chat("Wee005", "Notizen für das Jahresgespräch", 8_100),
  chat("Mon001", "Förderantrag Digitalisierung", 13_000),
  chat("Mon002", "Vorlage für Aufmaßprotokoll", 17_500, { projectId: "Prj01" }),
  chat("Mon003", "Checkliste Inventur", 22_000),
  chat("Mon004", "Antwort auf Bewertung im Netz", 26_000),
  chat("Old001", "Steuerberater: Fragen zur Umsatzsteuer", 50_000, { projectId: "Prj03" }),
  chat("Old002", "Einarbeitung neuer Azubi", 64_000),
  chat("Old003", "Ideen für den Tag der offenen Tür", 90_000),
];

const DONE: AiConversation[] = [
  chat("Don001", "Angebot Treppe Winter verschickt", 600, { isDone: true }),
  chat("Don002", "Bestellung Scharniere bestätigt", 2_900, { isDone: true }),
  chat("Don003", "Termin Gutachter abgestimmt", 9_800, { isDone: true }),
];

export const FIXTURE_PLACE_CHATS: AiConversation[] = [
  chat("Plc001", "Was steht in diesem Ordner?", 40, {
    place: {
      ref: { type: "filesv2.folder", id: "f_lindqvist" },
      title: "Küche Lindqvist",
      app: { id: "filesv2", name: "Dateien", icon: "ti ti-folder" },
    },
  } as Partial<AiConversation>),
  chat("Plc002", "Antwort auf die Anfrage entwerfen", 300, {
    place: {
      ref: { type: "mail.conversation", id: "m_4711" },
      title: "Anfrage Bad Oswald",
      app: { id: "mail", name: "Mail", icon: "ti ti-mail" },
    },
  } as Partial<AiConversation>),
];

const WORST: AiConversation[] = [
  chat("Wst001", "Angebot für die vollständige Neugestaltung der Küche einschließlich Elektro, Sanitär und Fliesenarbeiten im Altbau", 2, {
    runStatus: "running",
    activity: {
      completed: 1,
      total: 9,
      step: "Vergleicht die Preise von zwölf Lieferanten für Arbeitsplatten aus Granit und Quarzkomposit",
      tool: "web.search",
    },
  }),
  chat("Wst002", "https://lieferant-beispiel.example.org/katalog/2026/arbeitsplatten/granit-schwarz-poliert-30mm", 9, {
    unreadCompletion: true,
  }),
  chat("Wst003", "Ä", 30),
  chat("Wst004", "日本の取引先への見積書を作成する", 70, { runStatus: "needs_attention" }),
  chat("Wst005", "🪚🪵 Werkstatt-Ideen 🔨", 900, { runStatus: "failed" }),
  ...USUAL.slice(5),
];

const HUGE: AiConversation[] = Array.from({ length: 1_000 }, (_, index) =>
  chat(
    `Hug${String(index).padStart(4, "0")}`,
    `Chat ${index + 1}: ${["Angebot", "Rechnung", "Termin", "Bestellung", "Notiz"][index % 5]} ${index + 1}`,
    index * 45,
  ),
);

export const fixtureConversations = (state: AssistantV2FixtureState): AiConversation[] =>
  state === "empty" ? [] : state === "worst" ? [...WORST, ...DONE] : state === "huge" ? HUGE : [...USUAL, ...DONE];

export const fixtureProjects = (state: AssistantV2FixtureState): AiProject[] =>
  state === "empty"
    ? []
    : state === "worst"
      ? [
          project("Prj09", "Sanierung Altbau Hauptstraße 12 mit Denkmalschutzauflagen und Fördermitteln", "ti ti-building", ""),
          ...FIXTURE_PROJECTS,
        ]
      : FIXTURE_PROJECTS;

const message = (seq: number, role: "user" | "assistant", text: string): AiStoredMessage => ({
  id: `m${seq}`,
  shortId: `m${seq}`,
  conversationId: "Tod003",
  seq,
  kind: "message",
  message: { role, content: [{ type: "text", text }] } as AiStoredMessage["message"],
  loopId: role === "assistant" ? `turn${seq}` : null,
  modelId: null,
  providerModel: null,
  usage: null,
  stopReason: role === "assistant" ? "stop" : null,
  loopAggregate: null,
  loopDoneReason: role === "assistant" ? "stop" : null,
  compactedAt: null,
  meta: {},
  createdAt: at(60 - seq),
});

/** The open conversation: a question about an invoice and Gustav's answer. */
export const FIXTURE_MESSAGES: AiStoredMessage[] = [
  message(1, "user", "Bitte prüfe die Rechnung 2026-118 gegen das Angebot vom 3. November."),
  message(
    2,
    "assistant",
    "Ich habe Rechnung und Angebot verglichen.\n\n- **Arbeitsplatte Granit**: 1.480,00 € wie angeboten\n- **Montage**: 6 statt 5 Stunden, also 78,00 € mehr\n- **Anfahrt**: fehlt im Angebot, 45,00 €\n\nDie Rechnung liegt damit 123,00 € über dem Angebot. Soll ich eine kurze Rückfrage an den Lieferanten entwerfen?",
  ),
  message(3, "user", "Ja, bitte freundlich und kurz."),
  message(
    4,
    "assistant",
    "Gern, hier ist der Entwurf:\n\n> Guten Tag Frau Berger,\n> vielen Dank für Ihre Rechnung 2026-118. Im Angebot vom 3. November waren 5 Montagestunden und keine Anfahrt vorgesehen. Können Sie uns die Abweichung kurz erläutern?\n\nIch kann ihn als Mail-Entwurf anlegen.",
  ),
];

export const FIXTURE_OPEN_ID = "Tod003";

/** Waiting for you: one approval of a mail, a version to switch on, a secret, and two automations that need the person. */
export const FIXTURE_APPROVAL = {
  id: "33333333-3333-4333-8333-333333333333",
  app: { id: "mail", name: "Mail", icon: "ti ti-mail" },
  action: "draft.send",
  assurance: "confirm" as const,
  sentence: "Mail: Rückfrage zu Rechnung 2026-118 an Frau Berger senden",
  review: null,
  requester: { kind: "chat" as const, appId: "assistant", title: "Rechnung 2026-118 prüfen", href: "/app/assistant?conversation=Tod003" },
  remember: { chat: false, always: false, website: false },
  createdAt: at(12),
  expiresAt: at(-1440),
};
export const FIXTURE_QUESTIONS = {
  count: 3,
  items: [
    {
      id: "req-berger",
      kind: "approval" as const,
      conversationId: "Tod003",
      conversationTitle: "Rechnung 2026-118 prüfen",
      anchor: "tool-call-berger",
      short: "Mail: Rückfrage an Frau Berger senden",
      app: { name: "Mail", icon: "ti ti-mail" },
      createdAt: at(12),
    },
    {
      id: "code:v_lager2",
      kind: "code_activate" as const,
      conversationId: "Yes002",
      conversationTitle: "Fehler im Export der Lagerliste",
      anchor: "code-version-v_lager2",
      short: "Version 2 von „Lagerliste exportieren“ einschalten",
      app: { name: "Code", icon: "ti ti-player-play" },
      createdAt: at(300),
    },
    {
      id: "secret:shop",
      kind: "secret" as const,
      conversationId: "Wee003",
      conversationTitle: "Lieferanten für Kantenband vergleichen",
      anchor: "secret-shop",
      short: "Zugang zum Lieferantenportal eintragen",
      app: { name: "Gustav", icon: "ti ti-key" },
      createdAt: at(2_000),
    },
  ],
};
export const FIXTURE_AUTOMATIONS = [
  {
    id: "auto-woche",
    kind: "code_attention" as const,
    href: "/app/assistant/code/c_woche1",
    short: "Wochenbericht Vertrieb",
    reason: "chat_missing" as const,
  },
  {
    id: "auto-mahn",
    kind: "code_attention" as const,
    href: "/app/assistant/code/c_mahn01",
    short: "Mahnungen vorbereiten",
    reason: "chat_missing" as const,
    archivedChat: { id: "Old009", title: "Mahnlauf Oktober" },
  },
];
