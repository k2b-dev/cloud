import { Button, LocaleProvider, RunLog, type RunLogAction, type RunLogProps, type RunStepEntry } from "@k2b/ui";
import { createSignal, For, onCleanup } from "solid-js";
import { DemoCard } from "../DemoCard";
import { DemoGrid } from "./types";

const AT = "2026-11-17T16:42:07Z";
const plan = [
  { label: "Beleg lesen", icon: "ti ti-file-text", description: "Liest Text und Positionen aus dem PDF." },
  {
    label: "Einlieferer suchen",
    icon: "ti ti-user-search",
    description: "Sucht die Firma im Adressbuch, erst nach Kundennummer, dann nach Name.",
  },
  { label: "Daten erfassen", icon: "ti ti-table-plus", description: "Legt die Positionen im Lager an." },
];
const step = (i: number, status: RunStepEntry["status"], message?: string): RunStepEntry => ({
  kind: "step",
  id: `step-${i}`,
  at: AT,
  ...plan[i]!,
  status,
  message,
  startedAt: status === "pending" ? undefined : [AT, "2026-11-17T16:42:10Z", "2026-11-17T16:42:13Z"][i],
  endedAt:
    status === "succeeded" || status === "failed" ? ["2026-11-17T16:42:10Z", "2026-11-17T16:42:13Z", "2026-11-17T16:42:16Z"][i] : undefined,
});
const logs = [
  { kind: "log", id: "log-1", at: AT, level: "info", text: "PDF mit 2 Seiten erhalten" },
  { kind: "log", id: "log-2", at: "2026-11-17T16:42:09Z", level: "info", text: "14 Positionen gelesen" },
  { kind: "log", id: "log-3", at: "2026-11-17T16:42:11Z", level: "warn", text: "Position 9: Menge unleserlich, nehme 1" },
] as const;
const repeat: RunLogAction = { icon: "ti ti-refresh", label: "Wiederholen", onClick: () => {} };
const actions: RunLogAction[] = [repeat, { icon: "ti ti-pencil", label: "Ändern", primary: true, href: "#runlog-live" }];
const running: RunLogProps = {
  state: "running",
  duration: 6000,
  meta: "heute, 16:42",
  entries: [step(0, "succeeded"), step(1, "running"), step(2, "pending"), ...logs],
};
const succeeded: RunLogProps = {
  ...running,
  state: "succeeded",
  entries: [step(0, "succeeded"), step(1, "succeeded"), step(2, "succeeded"), ...logs],
  actions: [repeat],
};
const failed: RunLogProps = {
  ...running,
  state: "failed",
  duration: 8000,
  entries: [
    step(0, "succeeded"),
    step(1, "failed", "Kein Einlieferer mit Kundennummer K-20418 im Adressbuch. Prüfe die Kundennummer und wiederhole den Lauf."),
    step(2, "pending"),
    ...logs,
    { kind: "log", id: "log-4", at: "2026-11-17T16:42:13Z", level: "error", text: "Kein Einlieferer mit K-20418 im Adressbuch" },
  ],
  actions,
};

/** Fictional v13 states, shared with the catalog browser harness. RunLog itself never simulates a run. */
export const runLogExamples: readonly { id: string; title: string; props: RunLogProps; primary?: "ai"; locale?: string }[] = [
  {
    id: "idle",
    title: "Noch nicht ausgeführt",
    props: {
      state: "idle",
      entries: [],
      meta: "Belege erfassen",
      actions: [{ icon: "ti ti-player-play", label: "Ausführen", primary: true, onClick: () => {} }],
    },
    primary: "ai",
  },
  { id: "starting", title: "Startet", props: { state: "starting", entries: [], meta: "heute, 16:42" }, primary: "ai" },
  {
    id: "idle-plan",
    title: "Vor dem Lauf · Plan reserviert",
    props: { state: "idle", entries: plan.map((_, i) => step(i, "pending")) },
    primary: "ai",
  },
  {
    id: "starting-plan",
    title: "Startet · Plan reserviert",
    props: { state: "starting", entries: plan.map((_, i) => step(i, "pending")) },
    primary: "ai",
  },
  { id: "running", title: "Läuft", props: running, primary: "ai" },
  {
    id: "late-step",
    title: "Später angelegter Schritt",
    props: {
      ...running,
      entries: [...running.entries, { kind: "step", id: "late", at: AT, label: "Etiketten drucken", status: "pending" }],
    },
    primary: "ai",
  },
  { id: "succeeded", title: "Fertig · eine Aktion", props: succeeded, primary: "ai" },
  { id: "failed", title: "Gescheitert · mehrere Aktionen", props: failed, primary: "ai" },
  {
    id: "skipped",
    title: "Fertig · übersprungen",
    props: {
      ...succeeded,
      entries: [step(0, "succeeded"), step(1, "skipped", "Einlieferer stand schon am Beleg"), step(2, "succeeded"), ...logs],
    },
    primary: "ai",
  },
  {
    id: "step-states",
    title: "Alle Schrittzustände",
    props: {
      ...failed,
      output: "hidden",
      actions: [],
      entries: [
        step(0, "succeeded"),
        step(1, "failed", "Kundennummer fehlt"),
        step(2, "running"),
        { kind: "step", id: "skip", at: AT, label: "Preise prüfen", status: "skipped", message: "Nicht nötig, Festpreis" },
        { kind: "step", id: "pending", at: AT, label: "Bestätigung senden", status: "pending" },
      ],
    },
    primary: "ai",
  },
  { id: "output-open", title: "Ausgabe offen", props: { ...running, output: "open" }, primary: "ai" },
  {
    id: "empty-output-open",
    title: "Ausgabe offen · noch leer",
    props: { ...running, output: "open", entries: plan.map((_, i) => step(i, "pending")) },
    primary: "ai",
  },
  { id: "failed-output-open", title: "Fehlerausgabe offen", props: { ...failed, output: "open" }, primary: "ai" },
  {
    id: "many",
    title: "Viele Schritte · ältere Ausgabe",
    props: {
      ...running,
      output: "open",
      olderCount: 312,
      entries: [
        ...Array.from(
          { length: 13 },
          (_, i): RunStepEntry => ({
            kind: "step",
            id: `lager-${i}`,
            at: AT,
            label: `Lager ${i + 1} abgleichen`,
            status: i < 10 ? "succeeded" : i === 10 ? "running" : "pending",
          }),
        ),
        ...logs,
      ],
    },
    primary: "ai",
  },
  {
    id: "many-first",
    title: "Viele Schritte · erster Schritt läuft",
    props: {
      ...running,
      entries: Array.from(
        { length: 13 },
        (_, i): RunStepEntry => ({
          kind: "step",
          id: `first-${i}`,
          at: AT,
          label: `Lager ${i + 1} abgleichen`,
          status: i === 0 ? "running" : "pending",
        }),
      ),
    },
    primary: "ai",
  },
  {
    id: "step-durations",
    title: "Schrittdauer · Millisekunden bis Minuten",
    props: {
      ...succeeded,
      actions: [],
      entries: [
        { ...step(0, "succeeded"), startedAt: AT, endedAt: "2026-11-17T16:42:07.400Z" },
        { ...step(1, "succeeded"), startedAt: AT, endedAt: "2026-11-17T16:42:08.250Z" },
        { ...step(2, "succeeded"), startedAt: AT, endedAt: "2026-11-17T16:43:37Z" },
      ],
    },
    primary: "ai",
  },
  {
    id: "no-steps",
    title: "Ohne Schritte",
    props: {
      state: "succeeded",
      duration: 1000,
      entries: [{ kind: "log", id: "none", at: AT, level: "info", text: "Nichts zu tun" }],
      meta: "heute, 16:42",
    },
    primary: "ai",
  },
  {
    id: "no-output",
    title: "Noch keine Ausgabe",
    props: { ...running, entries: [step(0, "running"), step(1, "pending"), step(2, "pending")] },
    primary: "ai",
  },
  {
    id: "disconnected",
    title: "App: Verbindung weg",
    props: { ...running, meta: "Belege erfassen · Verbindung weg, verbinde neu …" },
    primary: "ai",
  },
  { id: "reconnected", title: "App: wieder verbunden", props: { ...running, meta: "Belege erfassen · wieder verbunden" }, primary: "ai" },
  { id: "compact-running", title: "Kompakt · läuft", props: { ...running, size: "compact" }, primary: "ai" },
  { id: "compact-done", title: "Kompakt · fertig", props: { ...succeeded, size: "compact" }, primary: "ai" },
  { id: "compact-failed", title: "Kompakt · gescheitert", props: { ...failed, size: "compact" }, primary: "ai" },
  {
    id: "compact-idle",
    title: "Kompakt · vor dem Lauf",
    props: {
      state: "idle",
      entries: [],
      size: "compact",
      meta: "Belege erfassen",
      actions: [{ icon: "ti ti-player-play", label: "Ausführen", primary: true, onClick: () => {} }],
    },
    primary: "ai",
  },
  { id: "app-running", title: "App · Primärfarbe", props: { ...running, meta: "Belege erfassen · heute, 16:42 · live" } },
  { id: "app-failed", title: "App · eine Aktion", props: { ...failed, actions: [{ ...repeat, primary: true }] } },
  { id: "english", title: "English · inherited locale", props: { ...failed, meta: "today, 16:42" }, locale: "en" },
];

function RunLogLiveDemo() {
  const [value, setValue] = createSignal<RunLogProps>({ state: "idle", entries: [], meta: "Belege erfassen" });
  const [feedback, setFeedback] = createSignal("");
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };
  onCleanup(stop);
  const play = (fail: boolean) => {
    stop();
    const frames: RunLogProps[] = [
      { state: "starting", entries: [], meta: "heute, 16:42" },
      { ...running, duration: 1000, entries: [step(0, "running"), step(1, "pending"), step(2, "pending")] },
      running,
      fail ? failed : succeeded,
    ];
    let index = 0;
    setValue(frames[index++]!);
    timer = setInterval(() => {
      setValue(frames[index++]!);
      if (index === frames.length) stop();
    }, 1100);
  };
  return (
    <DemoCard
      id="runlog-live"
      chip={{ kind: "component", name: "RunLog", from: "@k2b/ui" }}
      description="Live-Demo: Die Beispiel-App liefert Zustand, Zeit und Einträge. Ab Läuft bleibt die Karte gleich hoch."
      code={"<RunLog state={run.state} entries={run.entries} duration={run.duration} meta={run.meta} />"}
    >
      <LocaleProvider locale="de">
        <div data-k2b-primary="ai" class="ui-run-log-demo">
          <div class="ui-run-log-demo__controls">
            <Button size="sm" onClick={() => play(false)}>
              Lauf abspielen
            </Button>
            <Button size="sm" onClick={() => play(true)}>
              Lauf mit Fehler
            </Button>
            <Button
              size="sm"
              onClick={() => {
                stop();
                setValue({ ...running, meta: "Verbindung weg, verbinde neu …" });
              }}
            >
              Verbindung trennen
            </Button>
          </div>
          <RunLog {...value()} actions={value().state === "failed" ? [{ ...repeat, onClick: () => play(false) }, actions[1]!] : []} />
          <span role="status">{feedback()}</span>
          <Button
            size="sm"
            variant="text"
            onClick={() => {
              stop();
              setValue({ state: "idle", entries: [] });
              setFeedback("Zurückgesetzt");
            }}
          >
            Zurücksetzen
          </Button>
        </div>
      </LocaleProvider>
    </DemoCard>
  );
}

function RunLogExample(props: { example: (typeof runLogExamples)[number] }) {
  const [older, setOlder] = createSignal(props.example.props.olderCount ?? 0);
  const [loaded, setLoaded] = createSignal(0);
  const [feedback, setFeedback] = createSignal("");
  return (
    <DemoCard
      id={`runlog-${props.example.id}`}
      chip={{ kind: "component", name: "RunLog", from: "@k2b/ui" }}
      description={props.example.title}
      code={`<RunLog state="${props.example.props.state}" entries={entries} size="${props.example.props.size ?? "full"}" output="${props.example.props.output ?? "closed"}" />`}
    >
      <LocaleProvider locale={props.example.locale ?? "de"}>
        <div class="ui-run-log-demo" data-k2b-primary={props.example.primary}>
          <RunLog
            {...props.example.props}
            entries={[
              ...Array.from({ length: loaded() }, (_, i) => ({
                kind: "log" as const,
                id: `older-${i}`,
                at: AT,
                level: "info" as const,
                text: `Frühere Ausgabe ${i + 1}`,
              })),
              ...props.example.props.entries,
            ]}
            olderCount={older()}
            onLoadOlder={() => {
              setLoaded(older());
              setOlder(0);
              setFeedback("Ältere Ausgabe geladen");
            }}
            actions={props.example.props.actions?.map((action) =>
              action.href ? action : { ...action, onClick: () => setFeedback(`${action.label} angefordert`) },
            )}
          />
          <span class="ui-run-log-demo__feedback" role="status">
            {feedback()}
          </span>
        </div>
      </LocaleProvider>
    </DemoCard>
  );
}

export function RunLogDemos() {
  return (
    <DemoGrid columns="one">
      <RunLogLiveDemo />
      <For each={runLogExamples}>{(example) => <RunLogExample example={example} />}</For>
    </DemoGrid>
  );
}
