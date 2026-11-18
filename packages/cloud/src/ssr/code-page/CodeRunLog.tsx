import { i18n } from "@k2b/stdlib";
import { NoticeCard, RunLog, type RunEntry, type RunLogAction, type RunLogState, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { followCodeRun, readCodeRunEntries } from "../../browser/code-runs";
import { type CodeOutputWindow, type CodeOutputText, emptyCodeOutput, isCodeOutputLogEntry, isCodeOutputStepEntry } from "../../code/output";
import type { CodeRunEntries } from "../../code/run-ledger";
import type { CodePageRunDetail } from "./data";
import { codePageMessages } from "./messages";

const messages = i18n.define({ baseLocale: "en", messages: {
  en: { connecting: "Connecting…", stopped: "Updates stopped. Try again to load the current run.", revoked: "Access changed. Reload to check your access.", retry: "Try again", reload: "Reload", hidden: "Only people who manage this Code can see its output.", lost: ({ count }: { count: number }) => `${count} output entries could not be retained.`, ended: "Run ended before this step finished.", skipped: "Run skipped", secret: ({ name }: { name: string }) => `[Secret: ${name}]` },
  de: { connecting: "Verbindung wird hergestellt …", stopped: "Updates angehalten. Lade den aktuellen Lauf erneut.", revoked: "Zugriff geändert. Lade die Seite neu, um deinen Zugriff zu prüfen.", retry: "Erneut versuchen", reload: "Neu laden", hidden: "Nur wer diesen Code verwaltet, sieht seine Ausgabe.", lost: ({ count }: { count: number }) => `${count} Ausgabeeinträge konnten nicht aufbewahrt werden.`, ended: "Der Lauf endete, bevor dieser Schritt fertig war.", skipped: "Lauf übersprungen", secret: ({ name }: { name: string }) => `[Secret: ${name}]` },
} });

/** Convert sanitized structural parts only at presentation; unknown entry kinds stay harmless. */
export function codeRunLogEntries(output: CodeOutputWindow, locale: string): RunEntry[] {
  const t = messages.resolve([locale]).t;
  const text = (parts: CodeOutputText | undefined) => parts?.map((part) => part.type === "text" ? part.text : t.secret({ name: part.name })).join("");
  return output.entries.flatMap((entry): RunEntry[] => {
    if (isCodeOutputStepEntry(entry)) return [{ ...entry, label: text(entry.label) ?? "", icon: entry.icon ? `ti ti-${entry.icon}` : undefined,
      description: text(entry.description), message: entry.reason === "run_ended" ? t.ended : text(entry.message) }];
    if (isCodeOutputLogEntry(entry)) return [{ ...entry, level: entry.level === "warn" || entry.level === "error" ? entry.level : "info", text: text(entry.text) ?? "" }];
    return [];
  });
}

/** SSR supplies every initial row. The host owns the clock, live channel and recovery. */
export function CodeRunLog(props: { codeId: string; detail: CodePageRunDetail; now: string; manager: boolean; reason?: string | null; actions?: readonly RunLogAction[] }) {
  const locale = useLocale();
  const t = createMemo(() => messages.resolve([locale()]).t);
  const [snapshot, setSnapshot] = createSignal<CodeRunEntries>({
    state: props.detail.run.state, outcome: props.detail.run.outcome, startedAt: props.detail.run.startedAt, endedAt: props.detail.run.endedAt,
    output: props.manager ? props.detail.consoleOutput ?? emptyCodeOutput() : null,
  });
  const [now, setNow] = createSignal(Date.parse(props.now));
  const [connection, setConnection] = createSignal<"ready" | "loading" | "unavailable" | "revoked">("ready");
  let stop: (() => void) | undefined;
  createEffect(() => {
    if (props.manager) return;
    const run = props.detail.run;
    setSnapshot((current) => ({ ...current, state: run.state, startedAt: run.startedAt, endedAt: run.endedAt, output: null }));
  });
  const connect = () => {
    stop?.();
    setConnection("loading");
    stop = followCodeRun({ codeId: props.codeId, runId: props.detail.run.id }, {
      initial: snapshot(),
      snapshot: async (signal) => {
        const result = await readCodeRunEntries({ codeId: props.codeId, runId: props.detail.run.id }, signal);
        if (!result.ok) throw new Error("code_run_unavailable");
        return result.data.data;
      },
      apply: (current) => { setSnapshot(current); setConnection("ready"); },
      unavailable: (reason) => { setConnection(reason); if (reason === "revoked") setSnapshot((current) => ({ ...current, output: null })); },
    });
  };
  onMount(() => {
    if (props.manager && ["queued", "running"].includes(snapshot().state)) connect();
    const timer = ["queued", "running"].includes(snapshot().state) ? setInterval(() => {
      if (snapshot().state === "running") setNow(Date.now());
      else if (snapshot().state !== "queued") clearInterval(timer);
    }, 1000) : undefined;
    onCleanup(() => { if (timer) clearInterval(timer); stop?.(); });
  });
  const states: Record<CodeRunEntries["state"], RunLogState> = { queued: "starting", running: "running", succeeded: "succeeded", failed: "failed", cancelled: "failed", skipped: "idle" };
  const state = () => states[snapshot().state];
  const duration = () => snapshot().startedAt ? Math.max(0, (snapshot().endedAt ? Date.parse(snapshot().endedAt!) : now()) - Date.parse(snapshot().startedAt!)) : undefined;
  const reason = () => {
    if (snapshot().state === props.detail.run.state && props.reason) return props.reason;
    const code = snapshot().outcome;
    // The head already names the lifecycle. Keep the second line for a cause.
    if (code === "succeeded" || code === "failed") return null;
    const words = code ? codePageMessages.resolve([locale()]).t.outcome({ code }) : null;
    return words && words !== code ? words : props.reason;
  };
  const meta = () => connection() === "loading" ? t().connecting : connection() === "revoked" ? t().revoked : connection() === "unavailable" ? t().stopped : !snapshot().output ? t().hidden : snapshot().output!.droppedLines ? t().lost({ count: snapshot().output!.droppedLines }) : reason();
  const actions = (): readonly RunLogAction[] => [
    ...(connection() === "unavailable" ? [{ icon: "ti ti-refresh", label: t().retry, onClick: connect }] : []),
    ...(connection() === "revoked" ? [{ icon: "ti ti-refresh", label: t().reload, onClick: () => window.location.reload() }] : []),
    ...(props.actions ?? []),
  ];
  return <Show when={snapshot().state !== "skipped"} fallback={<NoticeCard tone="muted" icon="ti ti-player-skip-forward" title={t().skipped} detail={reason() ?? undefined} />}><RunLog state={state()} entries={snapshot().output ? codeRunLogEntries(snapshot().output!, locale()) : []}
    duration={duration()} output={props.manager && connection() !== "revoked" ? "open" : "hidden"}
    meta={<span role="status" title={meta() ?? undefined}>{meta()}</span>} actions={actions()} /></Show>;
}
