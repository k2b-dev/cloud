import { Button, Format, Section, StatusBadge, TextInput, useLocale } from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";
import type { AutomationLogItem } from "../contracts";
import { mailCodeHistoryMessages } from "./mail-code-history-messages";

/** A run of a retired rule; its technical snapshot is read only for the run the address names. */
export type MailRetiredRun = { id: string; createdAt: string; name: string; state: string; snapshot: unknown };

/** Serializable data of the step, read once on the server so reload and back show the same day, entry and run. */
export type MailCodeHistoryData = {
  codeHref: string;
  day: string;
  items: AutomationLogItem[];
  nextCursor: string | null;
  /** The entry the address names, shown below its row. */
  entry: string | null;
  runs: { items: MailRetiredRun[]; nextCursor: string | null } | null;
  /** The run the address names, with its snapshot. */
  run: MailRetiredRun | null;
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
export const mailCodeHistoryHref = (codeHref: string, state: Record<string, string | undefined>) => {
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
  const href = (state: Record<string, string | undefined>) => mailCodeHistoryHref(props.data.codeHref, state);
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
  const steps = (run: MailRetiredRun) => {
    const snapshot = run.snapshot as { steps?: unknown[] } | null;
    return Array.isArray(snapshot?.steps) ? snapshot.steps.length : 0;
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
        <form method="get" action={props.data.codeHref} class="mail-code-history__day">
          <input type="hidden" name="history" value="1" />
          <TextInput name="day" label={t().day} value={props.data.day} placeholder="YYYY-MM-DD" />
          <Button type="submit" variant="secondary">
            {t().show}
          </Button>
        </form>
        <Section title={t().log({ day: props.data.day })} size="md">
          <Show when={props.data.items.length} fallback={<p class="mail-code-catchup__quiet">{t().empty}</p>}>
            <ul class="mail-code-history__rows">
              <For each={props.data.items}>
                {(item) => (
                  <li class="mail-code-history__row" data-open={props.data.entry === item.id ? "" : undefined}>
                    <a
                      class="mail-code-history__line"
                      href={href({ day: props.data.day, entry: props.data.entry === item.id ? undefined : item.id })}
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
              <a class="k2b-text-link" href={href({ day: props.data.day, before: cursor() })}>
                {t().older}
              </a>
            )}
          </Show>
        </Section>
        <Show when={props.data.runs}>
          {(runs) => (
            <Section title={t().runs} size="md">
              <Show when={runs().items.length} fallback={<p class="mail-code-catchup__quiet">{t().noRuns}</p>}>
                <ul class="mail-code-history__rows">
                  <For each={runs().items}>
                    {(run) => (
                      <li class="mail-code-history__row" data-open={props.data.run?.id === run.id ? "" : undefined}>
                        <a
                          class="mail-code-history__line"
                          href={href({ day: props.data.day, run: props.data.run?.id === run.id ? undefined : run.id })}
                          aria-expanded={props.data.run?.id === run.id}
                        >
                          <span class="mail-code-history__time">
                            <Format.Date value={run.createdAt} />
                          </span>
                          <span class="mail-code-history__subject">{run.name}</span>
                          <StatusBadge tone="neutral" label={run.state} />
                        </a>
                        <Show when={props.data.run?.id === run.id && props.data.run}>
                          {(open) => (
                            <div class="mail-code-history__detail">
                              <p class="mail-code-catchup__quiet">{t().steps({ count: steps(open()) })}</p>
                              <details class="mail-code-history__technical">
                                <summary>{t().technical}</summary>
                                <pre>{JSON.stringify(open().snapshot, null, 2)}</pre>
                              </details>
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
                  <a class="k2b-text-link" href={href({ day: props.data.day, runAfter: cursor() })}>
                    {t().moreRuns}
                  </a>
                )}
              </Show>
            </Section>
          )}
        </Show>
      </div>
    </div>
  );
}
