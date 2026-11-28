import { dates } from "@k2b/stdlib";
import { ButtonLink, DatePicker, Format, Placeholder, Section, StatusBadge, type StatusTone, useLocale } from "@k2b/ui";
import { createSignal, For, type JSX, Show } from "solid-js";
import type { AutomationLogItem } from "../contracts";
import { mailCodeHistoryMessages } from "./mail-code-history-messages";

/** A run of a retired rule in the runs list. */
export type MailRetiredRun = { id: string; createdAt: string; name: string; state: string };
/** The run the address opens: its steps in words (key, state, error text), never its source or payloads. */
export type MailRetiredRunOpen = MailRetiredRun & {
  steps: { key: string; state: string; error: string | null }[];
  /** All steps of the run; past the shown ones the rest is named as a count. */
  stepCount: number;
};

/** Serializable data of the step, read once on the server so reload and back show the same day, entry and run. */
export type MailCodeHistoryData = {
  codeHref: string;
  day: string;
  /** The address named a day that is not a date: today is shown and the day field says so. */
  dayInvalid: boolean;
  /** Today in UTC, the last day the field offers; read on the server so both renders agree. */
  today: string;
  /** The cursor of the log page shown, kept when an entry or run opens. */
  before: string | null;
  items: AutomationLogItem[];
  nextCursor: string | null;
  /** The entry the address names, shown below its row. */
  entry: string | null;
  /** The cursor of the runs page shown, kept when an entry or run opens. */
  runAfter: string | null;
  /** Null when the runs could not be read. */
  runs: { items: MailRetiredRun[]; nextCursor: string | null } | null;
  /** The run the address names with its steps, or the run that could not be read. */
  run: MailRetiredRunOpen | { id: string; failed: true } | null;
};

/** The parts of the address that make up the step's state, in the order the address shows them. */
type HistoryState = { day: string; before?: string | null; entry?: string | null; runAfter?: string | null; run?: string | null };

const stateTones: Record<string, StatusTone> = {
  queued: "running",
  running: "running",
  waiting: "running",
  planned: "neutral",
  succeeded: "ok",
  completed: "ok",
  terminal: "ok",
  canceled: "neutral",
  unsupported: "warning",
  indeterminate: "warning",
  needs_attention: "warning",
  failed: "error",
};

const tones: Record<AutomationLogItem["outcome"], "ok" | "warning" | "error" | "neutral"> = {
  assigned: "ok",
  effects: "ok",
  uncertain: "warning",
  nobody: "warning",
  skipped: "neutral",
  manual_change: "neutral",
  failed: "error",
};

/** The address of the step on the Code page with these parts of its state. */
export const mailCodeHistoryHref = (codeHref: string, state: HistoryState) => {
  const query = new URLSearchParams({ history: "1" });
  for (const [name, value] of Object.entries(state)) if (value) query.set(name, value);
  return `${codeHref}?${query}`;
};

/**
 * The history of the retired Mail rules, a step of the mailbox's Code page: what the rules did on one day, one entry
 * opened with its reasons, and the earlier runs. Read-only and rendered on the server; every choice is an address.
 */
export default function MailCodeHistory(props: { data: MailCodeHistoryData }): JSX.Element {
  const locale = useLocale();
  const t = () => mailCodeHistoryMessages.resolve([locale()]).t;
  const href = (state: HistoryState) => mailCodeHistoryHref(props.data.codeHref, state);
  // opening an entry or a run keeps the pages shown, so the opened line stays on the page it was clicked on
  const current = (): HistoryState => ({
    day: props.data.day,
    before: props.data.before,
    entry: props.data.entry,
    runAfter: props.data.runAfter,
    run: props.data.run?.id ?? null,
  });
  const [day, setDay] = createSignal<string | null>(props.data.dayInvalid ? null : props.data.day);
  const heading = () => dates.formatDate(new Date(`${props.data.day}T00:00:00Z`), { locale: locale(), timeZone: "UTC" });
  const stateLabel = (state: string) => {
    const words = t();
    const labels: Record<string, string> = {
      queued: words.stateQueued,
      running: words.stateRunning,
      waiting: words.stateWaiting,
      planned: words.statePlanned,
      succeeded: words.stateSucceeded,
      completed: words.stateCompleted,
      terminal: words.stateTerminal,
      canceled: words.stateCanceled,
      unsupported: words.stateUnsupported,
      indeterminate: words.stateIndeterminate,
      needs_attention: words.stateNeedsAttention,
      failed: words.stateFailed,
    };
    return labels[state] ?? state;
  };
  const openRun = () => {
    const run = props.data.run;
    return run && !("failed" in run) ? run : null;
  };
  const effects = (item: AutomationLogItem) =>
    item.effects
      .map((effect) => {
        const words = t();
        switch (effect.kind) {
          case "assign":
            return words.effectAssign({ name: effect.target.name });
          case "unassign":
            return words.effectUnassign;
          case "tag":
            return words.effectTag({ name: effect.name });
          case "untag":
            return words.effectUntag({ name: effect.name });
          case "move":
            return words.effectMove({ folder: effect.folder });
          case "archive":
            return words.effectArchive;
          case "status":
            return words.effectStatus({ status: effect.status });
          case "read":
            return words.effectRead;
          case "unread":
            return words.effectUnread;
          case "flag":
            return words.effectMark({ name: effect.flag, present: effect.present });
          case "keyword":
            return words.effectMark({ name: effect.name, present: effect.present });
          case "comment":
            return words.effectComment;
          case "summary":
            return words.effectSummary;
        }
      })
      .join(" · ");
  const reason = (entry: AutomationLogItem["reasons"][number]) => {
    const words = t();
    switch (entry.kind) {
      case "comparison":
      case "condition":
        return entry.text;
      case "no_target":
        return words.reasonNoTarget({ choice: entry.choice });
      case "skipped_upper_rule":
        return words.reasonSkippedUpper({ name: entry.name });
      case "already_assigned":
        return words.reasonAlreadyAssigned;
      case "undone_before":
        return words.reasonUndoneBefore;
      case "reply_draft_occupied":
        return words.reasonReplyDraftOccupied;
      case "manual":
        return words.reasonManual;
      case "ai_choice":
        return words.reasonAiChoice({ value: entry.value });
      case "ai_value":
        return words.reasonAiValue({ field: entry.field, value: String(entry.value) });
    }
  };
  const outcome = (value: AutomationLogItem["outcome"]) => {
    const words = t();
    return {
      assigned: words.outcomeAssigned,
      uncertain: words.outcomeUncertain,
      nobody: words.outcomeNobody,
      skipped: words.outcomeSkipped,
      effects: words.outcomeEffects,
      manual_change: words.outcomeManualChange,
      failed: words.outcomeFailed,
    }[value];
  };
  return (
    <div class="mail-code-catchup mail-code-history">
      <header class="mail-code-catchup__head">
        <a class="k2b-text-link mail-code-catchup__back" href={props.data.codeHref}>
          <i class="ti ti-chevron-left" aria-hidden="true" />
          {t().back}
        </a>
        <h1 class="mail-code-catchup__title">{t().title}</h1>
        <p class="mail-code-catchup__lead">{t().lead}</p>
      </header>
      <div class="mail-code-catchup__stack">
        {/* a picked day opens at once: the step is an address, so reload and back return to it */}
        <div class="mail-code-history__day">
          <DatePicker
            label={t().day}
            value={day}
            onValueChange={setDay}
            onValueCommit={(value) => {
              if (value && value !== props.data.day) window.location.assign(href({ day: value }));
            }}
            max={props.data.today}
            error={props.data.dayInvalid && !day() ? t().dayInvalid : undefined}
          />
        </div>
        <Section title={t().log({ day: heading() })} size="md">
          <Show when={props.data.items.length} fallback={<p class="mail-code-catchup__quiet">{t().empty}</p>}>
            <ul class="mail-code-history__rows">
              <For each={props.data.items}>
                {(item) => (
                  <li class="mail-code-history__row" data-open={props.data.entry === item.id ? "" : undefined}>
                    <a
                      class="mail-code-history__line"
                      href={href({ ...current(), entry: props.data.entry === item.id ? null : item.id })}
                      aria-expanded={props.data.entry === item.id}
                    >
                      <span class="mail-code-history__time">
                        <Format.Time value={item.at} />
                      </span>
                      <span class="mail-code-history__who">{item.by.name}</span>
                      <span class="mail-code-history__subject">{item.conversation.subject}</span>
                      <StatusBadge tone={tones[item.outcome]} label={outcome(item.outcome)} />
                    </a>
                    <Show when={item.effects.length}>
                      <p class="mail-code-history__effects">{effects(item)}</p>
                    </Show>
                    <Show when={props.data.entry === item.id}>
                      <div class="mail-code-history__detail">
                        <Show when={item.reasons.length}>
                          <p class="mail-code-history__label">{t().why}</p>
                          <ul class="mail-code-catchup__rows">
                            <For each={item.reasons}>
                              {(entry) => (
                                <li class="mail-code-catchup__row">
                                  <i class="ti ti-point" aria-hidden="true" />
                                  <span>{reason(entry)}</span>
                                </li>
                              )}
                            </For>
                          </ul>
                        </Show>
                        <Show when={item.undo.by}>{(by) => <p class="mail-code-catchup__quiet">{t().undone({ name: by().name })}</p>}</Show>
                        <a class="k2b-text-link" href={item.conversation.href}>
                          {t().openConversation}
                        </a>
                      </div>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={props.data.nextCursor}>
            {(cursor) => (
              <a
                class="k2b-text-link"
                href={href({ day: props.data.day, before: cursor(), runAfter: props.data.runAfter, run: props.data.run?.id ?? null })}
              >
                {t().older}
              </a>
            )}
          </Show>
        </Section>
        <Section title={t().runs} size="md">
          <Show when={props.data.run && "failed" in props.data.run}>
            <Placeholder
              variant="compact"
              state="error"
              icon="ti ti-alert-triangle"
              title={t().runFailed}
              action={
                <ButtonLink href={href(current())} variant="secondary" size="sm">
                  {t().tryAgain}
                </ButtonLink>
              }
            />
          </Show>
          <Show
            when={props.data.runs}
            fallback={
              <Placeholder
                variant="compact"
                state="error"
                icon="ti ti-alert-triangle"
                title={t().runsFailed}
                action={
                  <ButtonLink href={href(current())} variant="secondary" size="sm">
                    {t().tryAgain}
                  </ButtonLink>
                }
              />
            }
          >
            {(runs) => (
              <>
                <Show when={runs().items.length} fallback={<p class="mail-code-catchup__quiet">{t().noRuns}</p>}>
                  <ul class="mail-code-history__rows">
                    <For each={runs().items}>
                      {(run) => (
                        <li class="mail-code-history__row" data-open={openRun()?.id === run.id ? "" : undefined}>
                          <a
                            class="mail-code-history__line"
                            data-kind="run"
                            href={href({ ...current(), run: openRun()?.id === run.id ? null : run.id })}
                            aria-expanded={openRun()?.id === run.id}
                          >
                            <span class="mail-code-history__time">
                              <Format.DateTime value={run.createdAt} />
                            </span>
                            <span class="mail-code-history__subject">{run.name}</span>
                            <StatusBadge tone={stateTones[run.state] ?? "neutral"} label={stateLabel(run.state)} />
                          </a>
                          <Show when={openRun()?.id === run.id && openRun()}>
                            {(open) => (
                              <div class="mail-code-history__detail">
                                <p class="mail-code-history__label">{t().steps({ count: open().stepCount })}</p>
                                <ul class="mail-code-history__steps">
                                  <For each={open().steps}>
                                    {(step) => (
                                      <li class="mail-code-history__step">
                                        <span class="mail-code-history__step-key">{step.key}</span>
                                        <StatusBadge
                                          tone={stateTones[step.state] ?? "neutral"}
                                          label={stateLabel(step.state)}
                                          variant="text"
                                        />
                                        <Show when={step.error}>
                                          {(error) => <span class="mail-code-history__step-error">{error()}</span>}
                                        </Show>
                                      </li>
                                    )}
                                  </For>
                                </ul>
                                <Show when={open().stepCount > open().steps.length}>
                                  <p class="mail-code-catchup__quiet">{t().moreSteps({ count: open().stepCount - open().steps.length })}</p>
                                </Show>
                              </div>
                            )}
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <Show when={runs().nextCursor}>
                  {(cursor) => (
                    <a class="k2b-text-link" href={href({ ...current(), entry: null, runAfter: cursor(), run: null })}>
                      {t().moreRuns}
                    </a>
                  )}
                </Show>
              </>
            )}
          </Show>
        </Section>
      </div>
    </div>
  );
}
