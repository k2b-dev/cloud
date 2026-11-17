import type { CodeActivityReadModel, CodeRunReadModel, CodeVersionReadModel } from "../../contracts/code-read-model";
import type {
  CodePageActivationRow,
  CodePageAutomation,
  CodePageData,
  CodePageReady,
  CodePageRefusal,
  CodePageRun,
  CodePageSecret,
  CodePageTarget,
  CodePageTargetRow,
  CodePageVersion,
  CodePageWords,
} from "./data";
import { sourceTabFixture } from "./source-tab.fixture";

/**
 * Fictional data only: the mailbox of a furniture shop, a logistics space, and Lea Muster's weekly report. Every state of
 * the v12 Code page has a name here, so tests and screenshots render the real page (Bauplan v12, section 6).
 */
type Locale = "de" | "en";
let lang: Locale = "de";
/** The text of the fixture's language; the fixture is built for one locale at a time. */
const L = (de: string, en: string) => (lang === "de" ? de : en);

/** The page's clock: Saturday, 14.11.2026, 13:49 in Berlin. */
const NOW = "2026-11-14T12:49:00.000Z";
const minutesAgo = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
const id = (group: number, index: number) => `00000000-0000-4000-8000-${String(group).padStart(4, "0")}${String(index).padStart(8, "0")}`;

const owner = {
  kind: "resource" as const,
  ref: { type: "mail.mailbox", id: "Mb4kd2" },
  title: "info@moebel-beispiel.de",
  typeTitle: "Postfach",
};
const ben = { id: "00000000-0000-4000-8000-0000000000b1", name: "Ben Schulz" };
const lea = { id: "00000000-0000-4000-8000-0000000000a1", name: "Lea Muster" };
const jana = { id: "00000000-0000-4000-8000-0000000000c1", name: "Jana Probe" };
const own: CodePageTarget = {
  key: "own",
  ref: owner.ref,
  title: owner.title,
  typeTitle: "Postfach",
  icon: "ti ti-inbox",
  own: true,
  href: "/app/mail/Mb4kd2",
};
/** A foreign target: the page links it by its type's page; the read model names it. */
const space: CodePageTarget = {
  key: "space",
  ref: { type: "spaces.space", id: "Lg8x2q" },
  title: null,
  typeTitle: "Space",
  icon: "ti ti-layout-kanban",
  own: false,
  href: "/app/spaces/Lg8x2q",
};

const CREATED: Record<number, string> = {
  5: "2026-11-14T12:41:00.000Z",
  4: "2026-10-28T09:00:00.000Z",
  3: "2026-10-21T09:00:00.000Z",
  2: "2026-10-19T14:00:00.000Z",
  1: "2026-10-14T09:00:00.000Z",
};
const version = (number: number, status: CodePageVersion["status"], extra: Partial<CodePageVersion> = {}): CodePageVersion => ({
  id: id(1, number),
  number,
  status,
  createdBy: number === 5 || number <= 2 ? lea : ben,
  createdAt: CREATED[number] ?? "2026-10-01T09:00:00.000Z",
  decisionLabel: null,
  decidedBy: null,
  active: false,
  ...extra,
});
const versions = () => {
  const v5 = version(5, "submitted", { createdAt: "2026-11-14T12:41:00.000Z" });
  const v4 = version(4, "approved", {
    active: true,
    decisionLabel: L("freigegeben von Jana Probe", "approved by Jana Probe"),
    decidedBy: jana,
  });
  const v3 = version(3, "approved", { decisionLabel: L("selbst freigegeben", "self-approved") });
  const v2 = version(2, "rejected", {
    decidedBy: jana,
    decisionComment: L("Bitte ohne Zugriff auf status.example.", "Please without access to status.example."),
  });
  const v1 = version(1, "approved");
  return { v5, v4, v3, v2, v1 };
};

/** The last 30 runs, newest first, every 15 minutes: one skipped, one failed two hours ago. */
const RUN_SHAPES: { state: CodePageRun["state"]; de: string; en: string }[] = [
  { state: "succeeded", de: "Aufgaben anlegen · 3 bestätigt", en: "Create tasks · 3 confirmed" },
  { state: "succeeded", de: "Keine bestätigte Wirkung", en: "No confirmed effect" },
  { state: "skipped", de: "Der vorige Lauf lief noch", en: "The previous run was still running" },
];
const runAt = (index: number) => minutesAgo(4 + index * 15);
const runs = (failedAt = 8): CodePageRun[] =>
  Array.from({ length: 30 }, (_, index) => {
    const shape =
      index === failedAt
        ? { state: "failed" as const }
        : index === 20
          ? { state: "skipped" as const }
          : (RUN_SHAPES[index] ?? RUN_SHAPES[0]!);
    return {
      id: id(2, index + 1),
      versionId: id(1, 4),
      versionNumber: 4,
      trigger: "schedule",
      entrypoint: "lieferungenEintragen",
      state: shape.state,
      outcome: shape.state === "failed" ? "failed" : shape.state === "skipped" ? "previous_schedule_running" : "succeeded",
      createdAt: runAt(index),
      startedAt: shape.state === "skipped" ? null : runAt(index),
      endedAt: shape.state === "skipped" ? null : new Date(Date.parse(runAt(index)) + 2000).toISOString(),
    };
  });
const runWords = (list: CodePageRun[]): Record<string, CodeRunReadModel> =>
  Object.fromEntries(
    list.map((run, index) => {
      const failed = run.state === "failed";
      const skipped = run.state === "skipped";
      const shape = RUN_SHAPES[index] ?? RUN_SHAPES[0]!;
      return [
        run.id,
        {
          runId: run.id,
          title: failed
            ? L("Alle 15 Minuten · 14.11.2026, 11:45", "Every 15 minutes · 14 Nov 2026, 11:45")
            : skipped
              ? L("Alle 15 Minuten", "Every 15 minutes")
              : L(shape.de, shape.en),
          state: failed ? "failed" : skipped ? "skipped" : "succeeded",
          status: failed ? L("Fehlgeschlagen", "Failed") : skipped ? L("Übersprungen", "Skipped") : L("Erfolgreich", "Successful"),
          at: run.createdAt,
          reason: failed
            ? L(
                "Der Lauf ist fehlgeschlagen. Prüfe vor einer Wiederholung, was bis dahin passiert ist.",
                "The run failed. Review what happened before running it again.",
              )
            : skipped
              ? L("Der vorige Lauf lief noch", "The previous run was still running")
              : null,
          untilThen: {
            items: failed
              ? [
                  { text: L("Unterhaltungen lesen · 2 bestätigt", "Read conversations · 2 confirmed") },
                  { text: L("1 Aufruf abgelehnt", "1 call refused") },
                ]
              : skipped
                ? [{ text: L("Keine bestätigten Wirkungen aufgezeichnet", "No confirmed effects recorded") }]
                : [
                    { text: L("Unterhaltungen lesen · 3 bestätigt", "Read conversations · 3 confirmed") },
                    { text: L("Aufgaben anlegen · 3 bestätigt", "Create tasks · 3 confirmed"), href: "/app/spaces/Lg8x2q" },
                    { text: L("Unterhaltungen verschieben · 3 bestätigt", "Move conversations · 3 confirmed") },
                  ],
            more: 0,
            moreText: null,
          },
          complete: true,
        } satisfies CodeRunReadModel,
      ];
    }),
  );

const automations = (list: CodePageRun[], extra: Partial<CodePageAutomation> = {}): CodePageAutomation[] => [
  {
    entrypoint: "lieferungenEintragen",
    title: L("Trägt neue Lieferavise ein", "Enters new delivery notes"),
    timingText: L("alle 15 Minuten", "every 15 minutes"),
    kind: "schedule",
    cron: "*/15 * * * *",
    isNew: false,
    lastRun: list.find((run) => run.state === "succeeded" || run.state === "failed") ?? null,
    nextRunAt: "2026-11-14T13:00:00.000Z",
    ...extra,
  },
  {
    entrypoint: "wochenbericht",
    title: L("Schickt die Wochenübersicht in den Space Logistik", "Sends the weekly overview to the Logistics space"),
    timingText: L("montags um 07:00", "Mondays at 07:00"),
    kind: "schedule",
    cron: "0 7 * * 1",
    isNew: false,
    lastRun: null,
    nextRunAt: "2026-11-16T06:00:00.000Z",
  },
];

const list = <T>(items: T[]) => ({ items, more: 0, moreText: null });
const changeRows = (long = false): CodeVersionReadModel["changes"]["rows"] =>
  list([
    { kind: "add" as const, text: L("Läuft zusätzlich Mo–Fr um 08:00", "Also runs Mon–Fri at 08:00") },
    {
      kind: "add" as const,
      text: L("Darf neu Dateien ablegen · Ordner Lieferscheine 2026", "May now file documents · folder Delivery notes 2026"),
    },
    ...(long
      ? [
          { kind: "add" as const, text: L("Internetzugriff · status.example", "Internet access · status.example") },
          { kind: "add" as const, text: L("Nutzt eine eigene Datenbank", "Uses its own database") },
          { kind: "add" as const, text: L("Wenn eine Aufgabe fällig wird · Space Logistik", "When a task becomes due · Logistics space") },
        ]
      : []),
    {
      kind: "remove" as const,
      text: L("Unterhaltungen markieren · Postfach info@moebel-beispiel.de", "Tag conversations · mailbox info@moebel-beispiel.de"),
    },
    ...Array.from({ length: 5 }, () => ({
      kind: "same" as const,
      text: L("Unterhaltungen lesen · Postfach info@moebel-beispiel.de", "Read conversations · mailbox info@moebel-beispiel.de"),
    })),
  ]);
const examples = (state: "passed" | "failed" | "none" = "passed"): CodeVersionReadModel["examples"] => {
  const items =
    state === "none"
      ? []
      : [
          {
            name: L("Lieferavis mit Lieferschein im Anhang", "Delivery note with a document attached"),
            modelLabel: L("✦ Von Gustav beschrieben · nicht von Cloud geprüft", "✦ Described by Gustav · not checked by Cloud"),
            state: "succeeded" as const,
            status: L("Erfolgreich", "Successful"),
            sentence: L("1 Aufgabe im Space Logistik angelegt, 1 Datei abgelegt.", "1 task created in the Logistics space, 1 file filed."),
            differences: [],
          },
          {
            name: L("Lieferavis ohne Anhang", "Delivery note without an attachment"),
            modelLabel: L("✦ Von Gustav beschrieben · nicht von Cloud geprüft", "✦ Described by Gustav · not checked by Cloud"),
            state: state === "failed" ? ("failed" as const) : ("succeeded" as const),
            status: state === "failed" ? L("Fehlgeschlagen", "Failed") : L("Erfolgreich", "Successful"),
            sentence:
              state === "failed"
                ? L("Weicht von der Erwartung ab.", "Differs from the expectation.")
                : L("1 Aufgabe im Space Logistik angelegt, keine Datei abgelegt.", "1 task created in the Logistics space, no file filed."),
            differences:
              state === "failed"
                ? [{ subject: L("Aufrufe", "Calls"), expected: L("Kein Wert", "No value"), actual: L("Liste · 1", "List · 1") }]
                : [],
          },
          {
            name: L("Woche ohne Lieferavis", "A week without delivery notes"),
            modelLabel: L("✦ Von Gustav beschrieben · nicht von Cloud geprüft", "✦ Described by Gustav · not checked by Cloud"),
            state: "succeeded" as const,
            status: L("Erfolgreich", "Successful"),
            sentence: L("Nichts geändert.", "Nothing changed."),
            differences: [],
          },
        ];
  const passed = items.filter((item) => item.state === "succeeded").length;
  return {
    state,
    passed,
    total: items.length,
    summary:
      state === "none"
        ? L("Keine Beispiele", "No examples")
        : L(`${passed} von ${items.length} Beispielen erfolgreich`, `${passed} of ${items.length} examples successful`),
    explanation: L(
      "Erfolgreich heißt: Die Automation hat Gustavs Erwartung erfüllt. Cloud bestätigt damit nicht, dass die Erwartung richtig ist.",
      "Successful means the automation met Gustav’s expectation. Cloud does not confirm that the expectation is correct.",
    ),
    items,
  };
};
const versionWords = (number: number, overrides: Partial<CodeVersionReadModel> = {}): CodeVersionReadModel => ({
  versionId: id(1, number),
  number,
  submittedAt: "2026-11-14T12:41:00.000Z",
  locale: lang,
  description: {
    state: "visible",
    text:
      number === 5
        ? L(
            "Legt künftig den Lieferschein aus dem Anhang jedes Lieferavis im Ordner „Lieferscheine 2026“ ab und läuft zusätzlich werktags um 8 Uhr. Das Markieren mit „Anfrage“ entfällt.",
            "From now on it files the delivery note attached to each delivery notice in the folder “Delivery notes 2026” and also runs on weekdays at 8. Tagging with “Request” is dropped.",
          )
        : L(
            "Trägt Lieferavise aus dem Postfach als Aufgaben im Space Logistik ein, weist die Unterhaltungen zu und sortiert sie in den Ordner „Lieferungen“.",
            "Enters delivery notices from the mailbox as tasks in the Logistics space, assigns the conversations and sorts them into the folder “Deliveries”.",
          ),
    modelLabel: L("✦ Von Gustav beschrieben · nicht von Cloud geprüft", "✦ Described by Gustav · not checked by Cloud"),
  },
  assurance: L(
    "Cloud begrenzt die Zugriffe auf die Apps und Ziele dieser Version.",
    "Cloud limits access to the apps and targets of this version.",
  ),
  mayDo: list([
    {
      text: L(
        "Unterhaltungen lesen, markieren, zuweisen und verschieben · Postfach info@moebel-beispiel.de",
        "Read, tag, assign and move conversations · mailbox info@moebel-beispiel.de",
      ),
      app: "Mail",
      icon: "tabler:mail",
    },
    {
      text: L("Aufgaben anlegen · Space Logistik", "Create tasks · Logistics space"),
      app: "Spaces",
      icon: "tabler:layout-kanban",
      href: "/app/spaces/Lg8x2q",
    },
  ]),
  timing: list([{ text: L("alle 15 Minuten", "every 15 minutes") }, { text: L("montags um 07:00", "Mondays at 07:00") }]),
  changes: {
    state: "changed",
    text: L("Zugriffe oder Auslöser geändert", "Access or triggers changed"),
    rows: list([
      {
        kind: "add" as const,
        text: L("Unterhaltungen zuweisen · Postfach info@moebel-beispiel.de", "Assign conversations · mailbox info@moebel-beispiel.de"),
      },
      { kind: "add" as const, text: L("Internetzugriff · bank.example", "Internet access · bank.example") },
      { kind: "remove" as const, text: L("Dateien ablegen · Ordner Lieferscheine", "File documents · folder Delivery notes") },
      { kind: "same" as const, text: L("Läuft alle 15 Minuten", "Runs every 15 minutes") },
    ]),
    assurance: L("Cloud prüft Zugriffe und Auslöser, nicht das Verhalten.", "Cloud checks access and triggers, not behavior."),
  },
  examples: examples(),
  notices: list([]),
  ...overrides,
});
const activity = (): CodeActivityReadModel => ({
  week: "2026-11-09T00:00:00.000Z",
  counters: list([
    {
      key: "spaces.task.create",
      automationKey: "lieferungenEintragen",
      text: L("Aufgaben angelegt · 41 bestätigt", "Tasks created · 41 confirmed"),
      count: 41,
    },
    {
      key: "mail.conversation.move",
      automationKey: "lieferungenEintragen",
      text: L("Unterhaltungen sortiert · 44 bestätigt", "Conversations sorted · 44 confirmed"),
      count: 44,
    },
  ]),
  recent: [
    {
      app: "Spaces",
      icon: "tabler:layout-kanban",
      text: L("Aufgabe „Lieferung Polsterei Weber“ angelegt", "Created task “Delivery Polsterei Weber”"),
      at: minutesAgo(4),
      href: "/app/spaces/Lg8x2q",
      runId: id(2, 1),
      target: { ref: { type: "spaces.item", id: "Lw3b8e" }, text: L("Aufgabe „{name}“ angelegt", "Created task “{name}”") },
    },
    {
      app: "Mail",
      icon: "tabler:mail",
      text: L("3 Unterhaltungen der Logistik zugewiesen", "Assigned 3 conversations to Logistics"),
      at: minutesAgo(4),
      runId: id(2, 1),
    },
    // A task in a list the reader may not open: Core's sentence without name or link, as the page leaves it.
    {
      app: "Spaces",
      icon: "tabler:layout-kanban",
      text: L("Aufgabe angelegt", "Created task"),
      at: minutesAgo(19),
      runId: id(2, 2),
      target: { ref: { type: "spaces.item", id: "Hd7q2w" }, text: L("Aufgabe „{name}“ angelegt", "Created task “{name}”") },
    },
    {
      app: "Mail",
      icon: "tabler:mail",
      text: L("2 Unterhaltungen nach „Lieferungen“ verschoben", "Moved 2 conversations to “Deliveries”"),
      at: minutesAgo(34),
      runId: id(2, 4),
    },
  ],
  timeline: { from: "2026-11-13T23:00:00.000Z", to: "2026-11-14T23:00:00.000Z", total: 0, marks: [] },
});

const targets: CodePageTargetRow[] = [
  { target: own, operations: ["mail.conversation.tag", "mail.conversation.assign"], newOperations: [] },
  { target: space, operations: ["spaces.task.create"], newOperations: [] },
];
const waitingTargets: CodePageActivationRow[] = [
  { target: own, operations: ["mail.conversation.tag", "mail.conversation.move"], isNew: true },
  { target: space, operations: ["spaces.task.create"], isNew: true },
];
const refusal = (run: CodePageRun, reader = false): CodePageRefusal => ({
  kind: "target_refused",
  runId: run.id,
  versionId: id(1, 4),
  call: reader ? null : { capability: "spaces.task.create", title: L("Aufgabe erstellen", "Create task"), target: space },
});
const detail = (run: CodePageRun, extra: Partial<NonNullable<CodePageReady["run"]>> = {}): NonNullable<CodePageReady["run"]> => ({
  run,
  calls:
    run.state === "failed"
      ? [
          {
            ordinal: 1,
            kind: "query",
            capability: "mail.conversation.list",
            target: owner.ref,
            refs: [],
            refusal: null,
            state: "succeeded",
            summary: null,
          },
          {
            ordinal: 2,
            kind: "action",
            capability: "spaces.task.create",
            target: space.ref,
            refs: [],
            refusal: "target_refused",
            state: "failed",
            summary: null,
          },
        ]
      : [],
  nextCallCursor: null,
  input: run.state === "failed" ? { messageId: "m1" } : null,
  inputTooLarge: false,
  refusal: run.state === "failed" ? refusal(run) : null,
  ...extra,
});

const ready = (overrides: Partial<CodePageReady> = {}, words: Partial<CodePageWords> = {}): CodePageReady => {
  const { v5, v4, v3, v2, v1 } = versions();
  const items = overrides.runs?.items ?? runs();
  const base: CodePageReady = {
    kind: "ready",
    code: {
      id: "c_3mfa",
      serviceAccountHandle: "code-7k2q9m4xwt",
      title: "Code von info@",
      state: "active",
      activeVersionId: v4.id,
      pauseReason: null,
      activatedAt: "2026-10-28T09:12:00.000Z",
      activatedBy: { name: "Ben Schulz" },
    },
    permission: "editor",
    versions: [v5, v4, v3, v2, v1].filter((version) => version.number !== 5),
    versionsFailed: false,
    moreVersions: false,
    active: v4,
    waiting: null,
    proposal: null,
    attentionReasons: null,
    internet: { active: ["https://bank.example", "https://status.example"], waiting: [] },
    automations: automations(items),
    targets,
    refusal: null,
    waitingTargets: null,
    operationLabels: {},
    runs: { items, nextCursor: null },
    run: null,
    diff: null,
    selectionFailed: false,
    secrets: null,
    secretNames: ["BUCHHALTUNG_TOKEN", "BANK_TOKEN"],
    secretOrigins: {},
    runFilter: "all",
    words: {
      current: versionWords(4),
      proposal: null,
      selected: null,
      activity: activity(),
      runs: runWords(items),
      ...words,
    },
    ...overrides,
  };
  return base;
};
/** Version 5 is ready and still off: the approval card above the situation, its new trigger marked. */
const withProposal = (status: CodePageVersion["status"], extra: Partial<CodePageVersion> = {}): Partial<CodePageReady> => {
  const { v5, v4, v3, v2, v1 } = versions();
  const proposal = { ...v5, status, ...extra };
  const waiting = status === "submitted" || status === "approved" || status === "pending" ? proposal : null;
  return {
    versions: [proposal, v4, v3, v2, v1],
    waiting,
    proposal,
    waitingTargets: waiting ? waitingTargets : null,
    internet: { active: ["https://bank.example", "https://status.example"], waiting: ["https://bank.example", "https://status.example"] },
  };
};
const secret = (name: string, origin: string, configured = true, by = jana, at = "2026-10-30T09:00:00.000Z"): CodePageSecret => ({
  name,
  binding_revision: id(3, name.length),
  origin,
  pathPrefix: "/",
  headers: ["authorization"],
  configured,
  valueSetBy: configured ? by : null,
  valueSetAt: configured ? at : null,
  usedIn: [{ number: 4, state: "active" }],
  unsubmitted: false,
});

/** Every state the v12 Code page shows; the old names stay for existing callers. */
export const CODE_PAGE_FIXTURE_STATES = [
  // Overview (Bild 19 to 21)
  "overview",
  "week-start",
  "new-version",
  "changes-requested",
  "needs-you",
  "paused",
  "with-pages",
  "empty",
  "loading",
  "error",
  "long",
  // Runs (Bild 22)
  "runs",
  "run-failed",
  "runs-list",
  "runs-empty",
  "runs-error",
  "runs-long",
  // Secrets (Bild 26)
  "secrets",
  "secrets-missing",
  "secrets-empty",
  "secrets-loading",
  "secrets-refused",
  "secrets-unknown",
  "secrets-long",
  // Versions (Bilder 23, 24)
  "versions",
  "versions-active",
  "versions-behavior",
  "versions-changes",
  "versions-rejected",
  "versions-list",
  "versions-first",
  "versions-loading",
  "versions-error",
  "versions-long",
  // Code tab, personal Code, others
  "code",
  "reader",
  "personal",
  "personal-needs-you",
  "personal-chat-missing",
  "personal-loading",
  "personal-error",
  "no-access",
] as const;
type NewState = (typeof CODE_PAGE_FIXTURE_STATES)[number];
/** Earlier fixture names, kept so existing harnesses and the render check keep working. */
type LegacyState =
  | "no-internet"
  | "internet-failed"
  | "waiting"
  | "approval"
  | "refused"
  | "refused-nolink"
  | "refused-reader"
  | "refused-unloaded"
  | "refused-policy"
  | "refused-approval"
  | "run-refused-policy"
  | "run-rerun"
  | "run-unclassified"
  | "versions-failed"
  | "waiting-unreadable"
  | "internet"
  | "secrets-error"
  | "secrets-replaced"
  | "secrets-submitted"
  | "secrets-unsubmitted"
  | "secrets-deleted"
  | "activated";
export type CodePageFixtureState = NewState | LegacyState;

export const codePageFixture = (state: CodePageFixtureState, locale = "de"): CodePageData => {
  lang = locale.startsWith("de") ? "de" : "en";
  const personalOwner = state.startsWith("personal");
  const base: Omit<CodePageData, "state" | "tab"> = {
    owner: personalOwner
      ? { kind: "person", ref: null, title: L("Wochenbericht Vertrieb", "Weekly sales report"), typeTitle: null, runsAs: null }
      : { ...owner, typeTitle: L("Postfach", "Mailbox") },
    href: personalOwner ? "/app/assistant/code/c_woche1" : "/app/mail/Mb4kd2/code",
    canManageOwner: true,
    activation: { allowed: true },
    editor: { provider: "assistant", label: "Gustav", icon: "ti ti-sparkles" },
    dates: { locale, timeZone: "Europe/Berlin", now: NOW },
    activatedNotice: null,
    cloudAdmin: false,
  };
  const failedNow = runs(0);
  switch (state) {
    case "empty":
      return { ...base, tab: "overview", state: { kind: "none" } };
    case "loading":
    case "personal-loading":
      return { ...base, tab: "overview", state: { kind: "loading" } };
    case "secrets-loading":
      return { ...base, tab: "secrets", state: { kind: "loading" } };
    case "versions-loading":
      return { ...base, tab: "versions", state: { kind: "loading" } };
    case "no-access":
      return { ...base, canManageOwner: false, tab: "overview", state: { kind: "no-access" } };
    case "error":
    case "personal-error":
      return { ...base, tab: "overview", state: { kind: "error" } };
    case "new-version":
    case "waiting":
    case "waiting-unreadable":
    case "internet": {
      const proposal = withProposal("submitted");
      const items = runs();
      return {
        ...base,
        tab: "overview",
        state: ready(
          {
            ...proposal,
            automations: [
              ...automations(items),
              {
                entrypoint: "lieferungenWerktags",
                title: L("Trägt neue Lieferavise ein", "Enters new delivery notes"),
                timingText: L("Mo–Fr um 08:00", "Mon–Fri at 08:00"),
                kind: "schedule",
                cron: "0 8 * * 1-5",
                isNew: true,
                lastRun: null,
              },
            ],
          },
          { proposal: versionWords(5, { changes: { ...versionWords(5).changes, rows: changeRows() } }) },
        ),
      };
    }
    case "approval":
      return {
        ...base,
        tab: "overview",
        state: ready(withProposal("pending"), {
          proposal: versionWords(5, { changes: { ...versionWords(5).changes, rows: changeRows() } }),
        }),
      };
    case "changes-requested":
      return {
        ...base,
        tab: "overview",
        state: ready(
          withProposal("changes_requested", {
            decidedBy: jana,
            decisionComment: L(
              "Bitte so ändern, dass nur PDF-Anhänge im Ordner landen. Sonst liegen dort bald auch Logos aus Signaturen.",
              "Please change it so that only PDF attachments end up in the folder. Otherwise logos from signatures will land there too.",
            ),
          }),
          { proposal: versionWords(5, { changes: { ...versionWords(5).changes, rows: changeRows() } }) },
        ),
      };
    case "needs-you":
    case "refused":
    case "refused-nolink":
    case "refused-reader":
    case "refused-unloaded":
    case "refused-policy":
    case "refused-approval": {
      const reader = state === "refused-reader";
      return {
        ...base,
        canManageOwner: !reader,
        tab: "overview",
        state: ready({
          permission: reader ? "reader" : "editor",
          runs: { items: failedNow, nextCursor: null },
          automations: automations(failedNow),
          refusal: refusal(failedNow[0]!, reader || state === "refused-unloaded"),
          words: { current: versionWords(4), proposal: null, selected: null, activity: activity(), runs: runWords(failedNow) },
        }),
      };
    }
    case "paused":
      return {
        ...base,
        tab: "overview",
        state: ready({ code: { ...ready().code, state: "paused", pausedAt: "2026-11-12T10:02:00.000Z" } }),
      };
    case "with-pages":
      return {
        ...base,
        tab: "overview",
        state: ready({
          internet: { active: ["https://api.buchhaltung-beispiel.de", "https://bank.example", "https://status.example"], waiting: [] },
          secretOrigins: { "https://api.buchhaltung-beispiel.de": ["BUCHHALTUNG_TOKEN"] },
          databaseUsed: true,
          code: { ...ready().code, database: { bytes: 12 * 1048576, limit: 100 * 1048576, state: "ready", canExport: true } },
          automations: [
            ...automations(runs()),
            {
              entrypoint: "route:rueckruf",
              title: L("Rückruf bestätigen", "Confirm callback"),
              kind: "route",
              route: { method: "GET", path: "/rueckruf", public: false },
              cron: null,
              isNew: false,
              lastRun: null,
            },
            {
              entrypoint: "route:kontakt",
              title: L("Eingang für das Kontaktformular", "Inbox for the contact form"),
              kind: "route",
              route: { method: "POST", path: "/kontakt", public: true },
              cron: null,
              isNew: false,
              lastRun: null,
            },
          ],
        }),
      };
    case "long":
      return {
        ...base,
        tab: "overview",
        state: ready({
          automations: [
            ...automations(runs()),
            ...Array.from({ length: 8 }, (_, index) => ({
              entrypoint: `ereignis${index}`,
              title: L(`Erinnert im Postfach an Lieferung ${index + 1}`, `Reminds about delivery ${index + 1} in the mailbox`),
              timingText: L("Wenn im Space Logistik eine Aufgabe fällig wird", "When a task becomes due in the Logistics space"),
              kind: "event" as const,
              cron: null,
              isNew: false,
              lastRun: runs()[index] ?? null,
            })),
          ],
          words: {
            current: versionWords(4, {
              mayDo: {
                items: [
                  ...versionWords(4).mayDo.items,
                  {
                    text: L(
                      "Aufgaben lesen und kommentieren · Space Einkauf Polsterstoffe und Bezugsmaterial Süd",
                      "Read and comment on tasks · space Upholstery and covering material South",
                    ),
                    app: "Spaces",
                    icon: "tabler:layout-kanban",
                  },
                  {
                    text: L("Dateien ablegen · Ordner Lieferscheine 2026", "File documents · folder Delivery notes 2026"),
                    app: L("Dateien", "Files"),
                    icon: "tabler:folder",
                  },
                ],
                more: 0,
                moreText: null,
              },
            }),
            proposal: null,
            selected: null,
            activity: activity(),
            runs: runWords(runs()),
          },
          databaseUsed: true,
        }),
      };
    case "activated":
      return { ...base, tab: "overview", activatedNotice: 4, state: ready() };
    case "no-internet":
      return { ...base, tab: "overview", state: ready({ internet: { active: [], waiting: [] } }) };
    case "internet-failed":
      return { ...base, tab: "overview", state: ready({}, { current: null }) };
    case "versions-failed":
      return { ...base, tab: "overview", state: ready({ ...withProposal("submitted"), versionsFailed: true }) };
    case "runs":
    case "runs-list":
    case "run-rerun":
    case "run-unclassified": {
      const items = runs();
      const selected = state === "run-rerun" ? { ...items[0]!, rerunOf: items[8]!.id, rerunByName: ben.name } : items[0]!;
      return {
        ...base,
        tab: "runs",
        state: ready({ run: detail(selected), runSelected: state !== "runs-list" }),
      };
    }
    case "run-failed":
    case "run-refused-policy": {
      const items = runs();
      return { ...base, tab: "runs", state: ready({ run: detail(items[8]!), runSelected: true }) };
    }
    case "runs-empty":
      return {
        ...base,
        tab: "runs",
        state: ready({ runs: { items: [], nextCursor: null }, automations: automations([]) }, { activity: null, runs: {} }),
      };
    case "runs-error":
      return { ...base, tab: "runs", state: ready({ runs: null }) };
    case "runs-long": {
      const items = runs();
      return { ...base, tab: "runs", state: ready({ runs: { items, nextCursor: "c30" }, run: detail(items[0]!), runSelected: true }) };
    }
    case "reader": {
      const items = runs();
      return {
        ...base,
        canManageOwner: false,
        tab: "runs",
        state: ready({
          permission: "reader",
          run: { ...detail(items[8]!), calls: null, refusal: refusal(items[8]!, true) },
          runSelected: true,
        }),
      };
    }
    case "secrets":
    case "secrets-missing":
    case "secrets-empty":
    case "secrets-error":
    case "secrets-refused":
    case "secrets-unknown":
    case "secrets-long":
    case "secrets-replaced":
    case "secrets-submitted":
    case "secrets-unsubmitted":
    case "secrets-deleted": {
      const first = secret("BUCHHALTUNG_TOKEN", "https://api.buchhaltung-beispiel.de");
      const second = secret(
        "BANK_TOKEN",
        "https://bank.example",
        state !== "secrets-missing" && state !== "secrets-deleted",
        ben,
        "2026-11-02T09:00:00.000Z",
      );
      const items =
        state === "secrets-empty"
          ? []
          : state === "secrets-long"
            ? [
                first,
                second,
                ...Array.from({ length: 10 }, (_, index) => secret(`LIEFERANT_${index + 1}`, `https://lieferant-${index + 1}.example`)),
              ]
            : [first, state === "secrets-unsubmitted" ? { ...second, unsubmitted: true } : second];
      const notice =
        state === "secrets-replaced"
          ? "replaced"
          : state === "secrets-submitted"
            ? "submitted"
            : state === "secrets-refused"
              ? "refused"
              : state === "secrets-unknown"
                ? "unknown"
                : null;
      return {
        ...base,
        tab: "secrets",
        state: ready({
          ...(state === "secrets-submitted" ? withProposal("pending") : {}),
          secretNames: items.map((item) => item.name),
          secrets:
            state === "secrets-error"
              ? null
              : { items, more: false, selected: items[0]?.name ?? null, notice, latest: { id: id(1, 4), number: 4 } },
        }),
      };
    }
    case "versions":
    case "versions-behavior":
    case "versions-changes":
    case "versions-rejected":
    case "versions-active":
    case "versions-list":
    case "versions-first":
    case "versions-error":
    case "versions-long": {
      if (state === "versions-first") {
        const v1 = { ...version(1, "approved"), active: true };
        return {
          ...base,
          tab: "versions",
          state: ready(
            {
              versions: [v1],
              active: v1,
              code: { ...ready().code, activeVersionId: v1.id },
              diff: { version: v1, comparison: null, staleComparison: false, internet: null, files: [], permissions: [] },
              versionSelected: true,
            },
            {
              current: versionWords(1, {
                description: { state: "missing", text: null, modelLabel: "" },
                changes: {
                  state: "first",
                  text: L("Erste Version", "First version"),
                  rows: list([
                    { kind: "same" as const, text: L("Läuft alle 15 Minuten", "Runs every 15 minutes") },
                    {
                      kind: "same" as const,
                      text: L(
                        "Unterhaltungen lesen und markieren · Postfach info@moebel-beispiel.de",
                        "Read and tag conversations · mailbox info@moebel-beispiel.de",
                      ),
                    },
                  ]),
                  assurance: L(
                    "Cloud prüft Zugriffe und Auslöser, nicht das Verhalten.",
                    "Cloud checks access and triggers, not behavior.",
                  ),
                },
                examples: examples("none"),
              }),
            },
          ),
        };
      }
      const status = state === "versions-changes" ? "changes_requested" : "submitted";
      const proposal = withProposal(
        status,
        state === "versions-changes"
          ? { decidedBy: jana, decisionComment: L("Bitte nur PDF-Anhänge ablegen.", "Please file PDF attachments only.") }
          : {},
      );
      const all = proposal.versions!;
      const pick =
        state === "versions-active" || state === "versions-long"
          ? all[1]!
          : state === "versions-rejected"
            ? all[3]!
            : state === "versions-list"
              ? null
              : all[0]!;
      const words5 = versionWords(5, {
        changes:
          state === "versions-behavior"
            ? {
                state: "access_same_behavior_changed",
                text: L("Zugriffe gleich, Verhalten anders", "Access unchanged, behavior changed"),
                rows: list([{ kind: "same" as const, text: L("Läuft alle 15 Minuten", "Runs every 15 minutes") }]),
                assurance: L("Cloud prüft Zugriffe und Auslöser, nicht das Verhalten.", "Cloud checks access and triggers, not behavior."),
              }
            : { ...versionWords(5).changes, rows: changeRows() },
      });
      return {
        ...base,
        tab: "versions",
        state: ready(
          {
            ...proposal,
            moreVersions: state === "versions-long",
            diff:
              pick && state !== "versions-error"
                ? { version: pick, comparison: null, staleComparison: false, internet: null, files: [], permissions: [] }
                : null,
            selectionFailed: state === "versions-error",
            versionSelected: state !== "versions-list",
          },
          {
            proposal: words5,
            selected:
              state === "versions-rejected" ? versionWords(2, { description: { state: "missing", text: null, modelLabel: "" } }) : null,
          },
        ),
      };
    }
    case "code":
      return { ...base, tab: "code", state: ready({ sourceTab: sourceTabFixture("code") }) };
    case "personal":
    case "personal-needs-you":
    case "personal-chat-missing": {
      const chatMissing = state === "personal-chat-missing";
      const weekly = Array.from({ length: 8 }, (_, index) => ({
        ...runs()[0]!,
        id: id(4, index + 1),
        entrypoint: "wochenbericht",
        state: state === "personal-needs-you" && index === 0 ? ("failed" as const) : ("succeeded" as const),
        createdAt: new Date(Date.parse("2026-11-09T06:00:00.000Z") - index * 7 * 86_400_000).toISOString(),
      }));
      const words = runWords(weekly);
      return {
        ...base,
        tab: "overview",
        state: ready(
          {
            code: {
              ...ready().code,
              id: "c_woche1",
              title: L("Wochenbericht Vertrieb", "Weekly sales report"),
              serviceAccountHandle: null,
            },
            internet: { active: [], waiting: [] },
            secretNames: [],
            versions: [{ ...version(2, "approved"), active: true }, version(1, "superseded")],
            active: { ...version(2, "approved"), active: true },
            runs: { items: weekly, nextCursor: null },
            refusal: null,
            // The chat Gustav built it in; archived in "personal-chat-missing", where the owner chooses or restores one.
            chatBinding: {
              codeId: "c_woche1",
              revision: 1,
              canChange: true,
              chat: chatMissing
                ? { state: "unavailable", reason: "archived", id: "Wk7chat", title: L("Wochenbericht", "Weekly report") }
                : {
                    state: "available",
                    id: "Wk7chat",
                    title: L("Wochenbericht", "Weekly report"),
                    project: null,
                    href: "/app/assistant?conversation=Wk7chat",
                  },
            },
            automations: [
              {
                entrypoint: "wochenbericht",
                title: L("Schreibt den Wochenbericht", "Writes the weekly report"),
                timingText: L("montags um 07:00", "Mondays at 07:00"),
                kind: "schedule",
                cron: "0 7 * * 1",
                isNew: false,
                lastRun: weekly[0]!,
                nextRunAt: "2026-11-16T06:00:00.000Z",
              },
            ],
          },
          {
            current: versionWords(2, {
              description: {
                state: "visible",
                text: L(
                  "Fasst jeden Montag deine offenen Angebote zusammen und legt den Bericht als Notiz im Notizbuch Vertrieb ab.",
                  "Every Monday it sums up your open offers and files the report as a note in the Sales notebook.",
                ),
                modelLabel: "",
              },
              mayDo: list([
                { text: L("Mails lesen · deine Postfächer", "Read mail · your mailboxes"), app: "Mail", icon: "tabler:mail" },
                {
                  text: L("Notizen anlegen · Notizbuch Vertrieb", "Create notes · Sales notebook"),
                  app: "Notebooks",
                  icon: "tabler:notebook",
                },
                {
                  text: L("Gustav fragen · zählt auf dein Kontingent", "Ask Gustav · counts against your quota"),
                  app: L("KI", "AI"),
                  icon: "tabler:sparkles",
                },
                // Named for the owner as the page names it (#77); without a chat only the safe sentence remains.
                chatMissing
                  ? {
                      text: L("In einen Chat schreiben, Gustav antwortet", "Write to a chat, Gustav answers"),
                      note: L("KI · mit deinen Rechten, zählt auf dein Kontingent", "AI · with your rights, counts toward your allowance"),
                      app: "Gustav",
                      icon: "tabler:message-chatbot",
                      // Core marks the row with the SDK's own handle; no reader names it.
                      target: {
                        ref: { type: "core.ai.chat", id: "bound-chat" },
                        text: L("In den Chat „{name}“ schreiben, Gustav antwortet", "Write to the chat “{name}”, Gustav answers"),
                      },
                    }
                  : {
                      text: L(
                        "In den Chat „Wochenbericht“ schreiben, Gustav antwortet",
                        "Write to the chat “Weekly report”, Gustav answers",
                      ),
                      note: L("KI · mit deinen Rechten, zählt auf dein Kontingent", "AI · with your rights, counts toward your allowance"),
                      app: "Gustav",
                      icon: "tabler:message-chatbot",
                      target: {
                        ref: { type: "core.ai.chat", id: "Wk7chat" },
                        text: L("In den Chat „{name}“ schreiben, Gustav antwortet", "Write to the chat “{name}”, Gustav answers"),
                      },
                    },
              ]),
              notices: list(
                chatMissing
                  ? [
                      {
                        code: "chat_missing" as const,
                        severity: "block" as const,
                        text: L("Diese Automation braucht einen Chat.", "This automation needs a chat."),
                        consequence: L("Wähle einen Chat oder stelle diesen wieder her.", "Choose a chat or restore this one."),
                      },
                    ]
                  : [],
              ),
              timing: list([{ text: L("montags um 07:00", "Mondays at 07:00") }]),
            }),
            activity: null,
            runs: words,
          },
        ),
      };
    }
    case "week-start": {
      // Monday morning: nothing counted this week yet, the latest results are from last week (Rundgang 6, Fable 8).
      const week = activity();
      return { ...base, tab: "overview", state: ready({}, { activity: { ...week, counters: { ...week.counters, items: [] } } }) };
    }
    default:
      return { ...base, tab: "overview", state: ready() };
  }
};
