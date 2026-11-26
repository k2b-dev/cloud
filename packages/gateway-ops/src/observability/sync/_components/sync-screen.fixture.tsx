import { LocaleProvider } from "@k2b/ui";
import { fixtureNav, LONG } from "../../_components/services-fixture-area";
import { syncQuery } from "../../_components/sync-nats-query";
import SyncScreen, { type SyncDeadLetterView, type SyncScreenProps } from "./SyncScreen.island";

const facets = { apps: ["mail", "spaces", "notebooks"] };
const base = "/admin/observability/nats/sync";

const letter = (messageId: string, extra: Partial<SyncDeadLetterView> = {}): SyncDeadLetterView => ({
  key: `mail/queue/outbox/${messageId}`,
  kind: "queue",
  appId: "mail",
  store: "outbox",
  messageId,
  tenantId: "t-1",
  appName: "Mail",
  attempts: "5",
  failedAt: "25.11.2026, 09:12",
  reason: "handler_failed — SMTP 451: greylisted",
  preview: '{"to":"ada@example.org","subject":"Rechnung 2026-114"}',
  storeHref: `${base}?storeApp=mail&store=outbox&kind=queue`,
  href: `${base}?storeApp=mail&store=outbox&kind=queue&message=${messageId}`,
  ...extra,
});

/** The Sync screen from invented overview data; `entry` opens the first dead letter, `worst` fills cells with worst cases. */
export const SyncScreenFixture = (props: { search?: string; worst?: boolean; entry?: boolean; locale?: string }) => {
  const locale = props.locale ?? "de";
  const state = syncQuery(locale, facets).parse(new URLSearchParams(props.search ?? "")).state;
  const deadLetters = props.worst
    ? [
        letter("m-1", { reason: `${LONG} — ${LONG}`, store: LONG, preview: LONG, attempts: "9.999.999" }),
        letter("m-2", { kind: "topic", consumer: undefined, replayAvailable: false }),
      ]
    : [letter("m-1"), letter("m-2", { kind: "topic", consumer: "mail-audit", replayAvailable: true, store: "events" })];
  const screen: SyncScreenProps = {
    nav: fixtureNav,
    facets,
    state,
    ignored: null,
    sampledAt: "25.11.2026, 10:42",
    refreshHref: base,
    facts: { reachable: "2", apps: "3", deadLetters: props.worst ? "20+" : "2", attention: "1", failingSchedules: "1" },
    unavailable: [{ name: "Notebooks", error: props.worst ? LONG : "connect ECONNREFUSED 10.0.0.12:3000" }],
    apps: [
      {
        id: "mail",
        name: "Mail",
        state: { label: "Bereit", status: "ok" },
        error: null,
        connection: "Verbunden",
        workers: "4",
        drifted: "0",
        dropped: "0",
      },
      {
        id: "spaces",
        name: "Spaces",
        state: { label: "Eingeschränkt", status: "warn" },
        error: null,
        connection: "Neu verbinden",
        workers: "1",
        drifted: "2",
        dropped: "17",
      },
      {
        id: "notebooks",
        name: "Notebooks",
        state: { label: "Nicht verfügbar", status: "bad" },
        error: "ECONNREFUSED",
        connection: "—",
        workers: "—",
        drifted: "—",
        dropped: "—",
      },
    ],
    deadLetters,
    store: null,
    resources: [
      {
        key: "mail/queue/outbox",
        appName: "Mail",
        kind: "queue",
        id: "outbox",
        natsHref: "/admin/observability/infrastructure/nats?stream=MAIL_OUTBOX",
        state: { label: "Bereit", status: "ok" },
        messages: "12",
        deadLetters: "2",
        deadLettersBad: true,
        error: "",
      },
      {
        key: "spaces/kv/presence",
        appName: "Spaces",
        kind: "kv",
        id: props.worst ? LONG : "presence",
        natsHref: null,
        state: { label: "Deklaration weicht ab", status: "warn" },
        messages: "—",
        deadLetters: "—",
        deadLettersBad: false,
        error: props.worst ? LONG : "max_age differs",
      },
    ],
    schedules: [
      {
        key: "mail/s/digest",
        appId: "mail",
        appName: "Mail",
        schedulerId: "mail-scheduler",
        id: "daily-digest",
        cron: "0 7 * * * · Europe/Berlin",
        nextRun: "26.11.2026, 07:00",
        handler: { label: "Verfügbar", status: "ok" },
        lastCompleted: "25.11.2026, 07:00",
        runs: "214",
        failures: "0",
        failing: false,
        lastError: "",
        lastRunId: null,
      },
      {
        key: "spaces/s/cleanup",
        appId: "spaces",
        appName: "Spaces",
        schedulerId: "spaces-scheduler",
        id: props.worst ? LONG : "cleanup",
        cron: "*/5 * * * * · UTC",
        nextRun: "25.11.2026, 10:45",
        handler: { label: "Nicht verfügbar", status: "warn" },
        lastCompleted: "—",
        runs: "9",
        failures: "3",
        failing: true,
        lastError: props.worst ? LONG : "timeout",
        lastRunId: "r-17",
      },
    ],
    entry: props.entry
      ? {
          error: null,
          closeHref: base,
          view: {
            title: props.worst ? LONG : "handler_failed",
            failedAt: "25.11.2026, 09:12",
            facts: [
              { label: "Fehlgeschlagen am", value: "25.11.2026, 09:12" },
              { label: "Versuche", value: "5" },
              { label: "Mandant", value: "t-1", mono: true },
              { label: "Nachricht", value: props.worst ? LONG : "m-1", mono: true },
            ],
            error: "SMTP 451: greylisted",
            preview: '{\n  "to": "ada@example.org"\n}',
            previewBounded: "Die Vorschau ist begrenzt; die Originalnachricht bleibt im Broker.",
            target: deadLetters[0]!,
            closeHref: base,
          },
        }
      : null,
  };
  return (
    <LocaleProvider locale={locale}>
      <SyncScreen {...screen} />
    </LocaleProvider>
  );
};

export default () => <SyncScreenFixture entry />;
