import { Button, IconButton, MarkdownView, ProgressRing, Skeleton, Tooltip, useLocale } from "@k2b/ui";
import { createMemo, createSignal, type JSX, Match, onCleanup, Show, Switch } from "solid-js";
import type { ConversationContentSummary } from "../../service/conversation-summary";
import { mailSummaryMessages } from "./mail-summary-messages";

export type MailSummaryGenerateMode = "rolling" | "replace";

/** Whether the reader shows the summary area at all: a text, or a rule or person waiting for one. */
export const showsConversationSummary = (state: ConversationContentSummary | null | undefined): state is ConversationContentSummary =>
  !!state && (!!state.summary || state.status !== "idle");

const formatTime = (iso: string, locale: string) => new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

/**
 * The conversation summary. An AI text sits on the cyan AI surface with ✦; a text a person wrote stays neutral.
 * Writing, failure and the daily limit replace the text in the same place, so the messages below never jump.
 */
export default function MailConversationSummaryCard(props: {
  state: ConversationContentSummary;
  canEdit: boolean;
  editDisabled?: boolean;
  onEdit: () => void;
  onGenerate: (mode: MailSummaryGenerateMode) => void;
  /** Opens the reminder for the next step's date; leaves the button out when absent. */
  onRemind?: (due: string) => void;
  generating?: boolean;
  now?: () => number;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailSummaryMessages.resolve([locale()]).t);
  const now = () => props.now?.() ?? Date.now();
  const [clock, setClock] = createSignal(now());
  const timer = setInterval(() => setClock(now()), 60_000);
  onCleanup(() => clearInterval(timer));

  const busy = () => props.generating || props.state.status === "writing" || props.state.status === "pending";
  const hasText = () => !!props.state.summary;
  /** Cyan only for what the AI wrote, and for AI work in progress. */
  const ai = () => (hasText() ? props.state.ai : true);
  const view = (): "writing" | "failed" | "limited" | "text" => {
    if (busy()) return "writing";
    if (props.state.status === "failed" && !hasText()) return "failed";
    if (props.state.status === "limited" && !hasText()) return "limited";
    return "text";
  };
  const ago = (iso: string | null) => {
    if (!iso) return null;
    const minutes = Math.max(0, Math.floor((clock() - Date.parse(iso)) / 60_000));
    if (minutes < 1) return t().justNow;
    if (minutes < 60) return t().minutesAgo({ minutes });
    return t().hoursAgo({ hours: Math.floor(minutes / 60) });
  };
  const source = () => {
    const state = props.state;
    const parts: string[] = [];
    if (state.ai && state.coveredMessageCount !== null)
      parts.push(
        state.truncated ? t().fromNewest({ count: state.coveredMessageCount }) : t().fromMessages({ count: state.coveredMessageCount }),
      );
    if (state.source === "workflow" && state.author) parts.push(t().byRule({ name: state.author.name }));
    else if (state.source === "manual_ai" && state.author) parts.push(t().onRequestOf({ name: state.author.name }));
    else if (state.source === "person") parts.push(state.author ? t().byPerson({ name: state.author.name }) : t().editedByPerson);
    const when = ago(state.generatedAt);
    if (when) parts.push(when);
    return parts.join(" · ");
  };
  const failureText = () => {
    switch (props.state.failure?.code) {
      case "timeout":
        return t().failed_timeout;
      case "provider_unavailable":
        return t().failed_provider_unavailable;
      case "input_too_large":
        return t().failed_input_too_large;
      case "allowance_exhausted":
        return t().failed_allowance_exhausted;
      default:
        return t().failed_internal;
    }
  };
  const limitText = () => {
    const limit = props.state.limit;
    return limit?.scope === "rule" && limit.workflow
      ? t().limitRule({ limit: limit.limit, name: limit.workflow.name })
      : t().limitMailbox({ limit: limit?.limit ?? 0 });
  };
  const why = () =>
    props.state.ai ? t().whyAi({ rule: props.state.source === "workflow" ? (props.state.author?.name ?? null) : null }) : t().whyPerson;

  const tool = (label: string, icon: string, onClick: () => void, disabled?: boolean): JSX.Element => (
    <Tooltip.Anchor content={label}>
      <IconButton type="button" size="sm" variant="ghost" label={label} disabled={disabled} onClick={onClick}>
        <i class={`ti ${icon}`} aria-hidden="true" />
      </IconButton>
    </Tooltip.Anchor>
  );

  return (
    <section
      class="mx-auto my-3 flex w-full max-w-4xl flex-col rounded-[0.875rem] px-[1.125rem] pt-3.5 pb-3 text-sm"
      classList={{
        "min-h-[12.25rem]": ai(),
        "bg-[var(--k2b-ai-surface)] text-cyan-950 dark:text-cyan-50": ai(),
        "bg-[var(--ui-surface-subtle)] text-primary": !ai(),
      }}
      aria-labelledby="mail-conversation-summary-title"
      aria-busy={busy()}
      data-mail-conversation-summary={view()}
      data-mail-summary-ai={ai() ? "" : undefined}
    >
      <div class="flex min-h-8 items-center gap-2">
        <Show when={ai()}>
          <i class="ti ti-sparkles text-[1.0625rem] text-[color:var(--k2b-ai-accent)]" aria-hidden="true" />
        </Show>
        <h2 id="mail-conversation-summary-title" class="text-sm font-semibold">
          {t().title}
          <Show when={ai()}>
            <span class="sr-only"> ({t().aiLabel})</span>
          </Show>
        </h2>
        <Show when={view() === "writing"}>
          <span class="text-xs opacity-80" aria-live="polite">
            {t().writing}
          </span>
        </Show>
        <Show when={view() === "text"}>
          <span class="ml-auto flex items-center gap-0.5">
            <Show when={props.state.canGenerate}>{tool(t().rewrite, "ti-refresh", () => props.onGenerate("replace"))}</Show>
            <Show when={props.canEdit}>{tool(t().edit, "ti-pencil", props.onEdit, props.editDisabled)}</Show>
            <Tooltip.Anchor content={why()}>
              <IconButton type="button" size="sm" variant="ghost" label={t().why}>
                <i class="ti ti-info-circle" aria-hidden="true" />
              </IconButton>
            </Tooltip.Anchor>
          </span>
        </Show>
      </div>

      <Switch>
        <Match when={view() === "writing"}>
          <div class="my-3.5 flex flex-col gap-2.5" aria-hidden="true">
            <Skeleton class="h-3 w-[92%] rounded" />
            <Skeleton class="h-3 w-[78%] rounded" />
            <Skeleton class="h-3 w-[60%] rounded" />
          </div>
          <Skeleton class="h-3 w-2/5 rounded" />
          <div class="mt-auto pt-2.5">
            <Skeleton class="h-2.5 w-1/2 rounded" />
          </div>
        </Match>

        <Match when={view() === "failed"}>
          <p class="my-2.5 max-w-[62ch]" role="alert">
            {failureText()}
          </p>
          <Show when={props.state.canGenerate}>
            <div>
              <Button size="sm" variant="secondary" onClick={() => props.onGenerate("replace")}>
                <i class="ti ti-refresh" aria-hidden="true" /> {t().tryAgain}
              </Button>
            </div>
          </Show>
          <p class="mt-auto pt-2.5 text-xs opacity-80">
            {[
              props.state.failure?.workflow ? t().byRule({ name: props.state.failure.workflow.name }) : null,
              props.state.failure
                ? t().attempts({ count: props.state.failure.attempts, time: formatTime(props.state.failure.lastAttemptAt, locale()) })
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </Match>

        <Match when={view() === "limited"}>
          <p class="my-2.5 max-w-[62ch]">{limitText()}</p>
          <Show when={props.state.canGenerate}>
            <div>
              <Button size="sm" variant="secondary" onClick={() => props.onGenerate("replace")}>
                <i class="ti ti-sparkles text-[color:var(--k2b-ai-accent)]" aria-hidden="true" /> {t().summarizeThisOne}
              </Button>
            </div>
          </Show>
          <p class="mt-auto flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pt-2.5 text-xs opacity-80">
            <span>{t().countsOnAllowance}</span>
            <Show when={props.state.allowance && !props.state.allowance.unlimited && props.state.allowance.usedPercent !== null}>
              <span class="inline-flex items-center gap-1 whitespace-nowrap">
                <ProgressRing value={props.state.allowance?.usedPercent ?? 0} label={t().countsOnAllowance} />
                {t().allowanceUsed({ percent: Math.round(props.state.allowance?.usedPercent ?? 0) })}
              </span>
            </Show>
          </p>
        </Match>

        <Match when={view() === "text"}>
          <Show when={props.state.newMessagesSince > 0}>
            <p class="mt-2 flex items-center gap-1.5 text-[0.8125rem]">
              <i class="ti ti-arrow-up" aria-hidden="true" />
              <span>{t().newSince({ count: props.state.newMessagesSince })}</span>
              <Show when={props.state.canGenerate}>
                <button
                  type="button"
                  class="underline decoration-[color:var(--k2b-ai-accent)] underline-offset-2"
                  onClick={() => props.onGenerate("rolling")}
                >
                  {t().continue}
                </button>
              </Show>
            </p>
          </Show>
          <Show when={props.state.status === "failed" || props.state.status === "limited"}>
            <p class="mt-2 text-[0.8125rem]" role="status">
              {props.state.status === "failed" ? t().updateFailed : limitText()}
            </p>
          </Show>
          <div class="my-2" data-mail-conversation-summary-body>
            <MarkdownView markdown={props.state.summary ?? ""} headingScale="compact" class="text-sm text-inherit" />
          </div>
          <Show when={props.state.nextStep}>
            {(next) => (
              <div class="flex flex-wrap items-center gap-2.5">
                <span class="inline-flex items-center gap-1.5 text-[0.78125rem] opacity-85">
                  <i class="ti ti-calendar-due" aria-hidden="true" /> {t().nextStep}
                </span>
                <b>{next().text}</b>
                <Show when={next().due && props.onRemind}>
                  <span class="ml-auto inline-flex gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => props.onRemind?.(next().due!)}>
                      <i class="ti ti-alarm" aria-hidden="true" /> {t().remind}
                    </Button>
                  </span>
                </Show>
              </div>
            )}
          </Show>
          <Show when={source()}>
            <p class="mt-auto pt-2.5 text-xs opacity-80">{source()}</p>
          </Show>
        </Match>
      </Switch>
    </section>
  );
}
