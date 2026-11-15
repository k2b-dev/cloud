import type { ApprovalPage, PendingApproval } from "@k2b/cloud/contracts/approvals";
import type { CodeActivityReadModel } from "@k2b/cloud/contracts/code-read-model";
import type { CodeAttentionView } from "./AssistantCodeAttention";
import type { CodeCardRun, CodeOverviewItem, CodeOverviewPage } from "./code-overview";

/**
 * Fictional data for "My apps & automations" and "Waiting for you", one export per state of concept gustav-ui-neu v12
 * (picture 27, scene `#meine-apps` and `#wartet`). Render tests and screenshots use the same data; freeze the clock at
 * `FIXTURE_NOW` and use `FIXTURE_TIME_ZONE`.
 */
export const FIXTURE_NOW = "2026-11-14T13:10:00.000Z";
export const FIXTURE_TIME_ZONE = "Europe/Berlin";
/** The person's day in Berlin: 14.11.2026, 00:00 to 24:00 local time. */
const DAY = { from: "2026-11-13T23:00:00.000Z", to: "2026-11-14T23:00:00.000Z" };

export type AppsState = "normal" | "leer" | "laedt" | "fehler" | "lang";
export type WaitingState = "normal" | "leer" | "laedt" | "fehler" | "lang";

const now = Date.parse(FIXTURE_NOW);
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
/** A local Berlin time of the fixture day, as an instant. */
const local = (time: string) => new Date(Date.parse(`2026-11-14T${time}:00+01:00`)).toISOString();
const uuid = (code: number, index: number) => `${String(code).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`;

/** Runs from oldest to newest as letters: o succeeded, f failed, s skipped, r running; returned newest first. */
const runs = (code: number, pattern: string, newestAt: string, hours = 24): CodeCardRun[] =>
  [...pattern]
    .map((letter, index) => {
      const at = new Date(Date.parse(newestAt) - (pattern.length - 1 - index) * hours * 3_600_000).toISOString();
      return {
        id: uuid(code, index + 1),
        state: ({ o: "succeeded", f: "failed", s: "skipped", r: "running" } as const)[letter as "o" | "f" | "s" | "r"],
        createdAt: at,
        startedAt: at,
        endedAt: letter === "r" ? null : new Date(Date.parse(at) + 40_000).toISOString(),
      };
    })
    .reverse();

const activity = (recent: string | null, marks: CodeActivityReadModel["timeline"]["marks"]): CodeActivityReadModel => ({
  week: "2026-11-09T00:00:00.000Z",
  counters: { items: [], more: 0, moreText: null },
  recent: recent ? [{ text: recent, at: ago(30), runId: uuid(9, 1) }] : [],
  timeline: { ...DAY, marks, total: marks.length },
});
const mark = (time: string, state: CodeActivityReadModel["timeline"]["marks"][number]["state"], runId?: string) => ({
  at: local(time),
  state,
  count: 1,
  ...(runId ? { runId } : {}),
});

const automation = (kind: "schedule" | "event", cron: string | null, nextRunAt: string | null) => ({
  entrypoint: "run",
  kind,
  cron,
  nextRunAt,
  lastRun: null,
  missingTargets: [],
});

/** The four cards of picture 27: on, running, last run failed, paused. */
const CARDS = (): CodeOverviewItem[] => {
  const woche = runs(1, "oooooooo", "2026-11-09T06:00:40.000Z", 24 * 7);
  const rueck = runs(2, "ooooosor", new Date(now - 3_000).toISOString(), 5);
  const stoff = runs(3, "ooooooof", local("06:30"), 24);
  const angeb = runs(4, "oooo", "2026-10-23T14:00:40.000Z", 24 * 7);
  return [
    {
      id: "c_woche1",
      title: "Wochenbericht Vertrieb",
      state: "active",
      lastRun: woche[0]!,
      automations: [automation("schedule", "0 7 * * 1", "2026-11-16T06:00:00.000Z")],
      removedTargets: [],
      extras: { runs: woche, activity: activity("1 Notiz „Wochenbericht KW 45“ angelegt", []), failure: null },
    },
    {
      id: "c_rueck1",
      title: "Rückfragen sammeln",
      state: "active",
      lastRun: rueck[0]!,
      automations: [automation("event", null, null)],
      removedTargets: [],
      extras: {
        runs: rueck,
        activity: activity(
          "2 Rückfragen in deiner Liste gesammelt",
          [
            ["07:00", "succeeded"],
            ["08:00", "succeeded"],
            ["09:10", "succeeded"],
            ["10:05", "succeeded"],
            ["11:00", "succeeded"],
            ["12:00", "succeeded"],
            ["12:58", "succeeded"],
            ["13:40", "succeeded"],
            ["14:00", "succeeded"],
            ["14:10", "running"],
          ].map(([time, state], index) => mark(time!, state as "succeeded" | "running", uuid(2, 20 + index))),
        ),
        failure: null,
      },
    },
    {
      id: "c_stoff1",
      title: "Stoffpreise prüfen",
      state: "active",
      lastRun: stoff[0]!,
      automations: [automation("schedule", "30 6 * * *", "2026-11-15T05:30:00.000Z")],
      removedTargets: [],
      extras: {
        runs: stoff,
        activity: activity(null, [
          mark("06:30", "failed", stoff[0]!.id),
          mark("15:10", "planned"),
          mark("16:50", "planned"),
          mark("19:00", "planned"),
          mark("21:10", "planned"),
        ]),
        failure: "Preisliste von stoffe-nord.example nicht erreichbar",
      },
    },
    {
      id: "c_angeb1",
      title: "Angebote nachfassen",
      state: "paused",
      lastRun: angeb[0]!,
      automations: [automation("schedule", "0 15 * * 5", null)],
      removedTargets: [],
      extras: { runs: angeb, activity: activity("3 Angebote nachgefasst", []), failure: null },
    },
  ];
};

/** Fourteen cards, two that need the person and three paused, so the filter chips show. */
const MANY = (): CodeOverviewItem[] => {
  const [on, running, failed, paused] = CARDS() as [CodeOverviewItem, CodeOverviewItem, CodeOverviewItem, CodeOverviewItem];
  const kinds = [on, running, failed, paused, on, on, paused, on, failed, on, paused, on, on, on];
  return kinds.map((item, index) => ({ ...item, id: `c_lang${String(index).padStart(2, "0")}`, title: `${item.title} ${index + 1}` }));
};

/** Props for `AssistantCodeView` in one state; `initial` undefined renders "loading" until the browser read answers. */
export const myAppsFixture = (state: AppsState): { initial: CodeOverviewPage | null | undefined } => {
  if (state === "laedt") return { initial: undefined };
  if (state === "fehler") return { initial: null };
  if (state === "leer") return { initial: { items: [], nextCursor: null } };
  return { initial: { items: state === "lang" ? MANY() : CARDS(), nextCursor: null } };
};

const approval = (who: string, number: number, minutesAgo: number): PendingApproval => ({
  id: uuid(7, number),
  app: { id: "mail", name: "Mail", icon: "ti ti-mail" },
  action: "draft.send",
  assurance: "confirm",
  sentence: `Mail: Angebot 2026-11${7 + number} an ${who} senden`,
  review: null,
  requester: { kind: "chat", appId: "assistant", title: `Angebot an ${who}`, href: `/app/assistant?conversation=Chat${number}` },
  remember: { chat: false, always: false, website: false },
  createdAt: ago(minutesAgo),
  expiresAt: new Date(now + 23 * 3_600_000).toISOString(),
});

const ATTENTION: CodeAttentionView = {
  nextCursor: null,
  items: [
    {
      codeId: "c_info02",
      title: "Lieferungen eintragen",
      owner: { kind: "resource", ref: { type: "mail.mailbox", id: "m_info" } },
      reasons: ["run_failed", "access_missing"],
      lastRunAt: ago(20),
      place: { name: "info@moebel-beispiel.de", type: "Postfach", href: "/app/mail/m/info" },
    },
  ],
};

/** Props for `AssistantApprovalsView` in one state; `initial` null is a list Core could not read. */
export const waitingFixture = (
  state: WaitingState,
): { initial: ApprovalPage | null | undefined; initialAttention: CodeAttentionView | null | undefined } => {
  if (state === "laedt") return { initial: undefined, initialAttention: undefined };
  if (state === "fehler") return { initial: null, initialAttention: ATTENTION };
  if (state === "leer")
    return { initial: { items: [], nextCursor: null, count: 0, elsewhere: 0 }, initialAttention: { items: [], nextCursor: null } };
  if (state === "lang")
    return {
      initial: {
        items: [approval("Jana Probe", 1, 60), approval("Tom Beispiel", 2, 70), approval("Ben Schulz", 3, 90)],
        nextCursor: "page-2",
        count: 9,
        elsewhere: 0,
      },
      initialAttention: ATTENTION,
    };
  return {
    initial: { items: [approval("Jana Probe", 1, 60), approval("Lea Muster", 2, 3)], nextCursor: null, count: 2, elsewhere: 0 },
    initialAttention: ATTENTION,
  };
};
