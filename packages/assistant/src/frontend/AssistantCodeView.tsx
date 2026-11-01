import { describeCodeSchedule } from "@k2b/cloud/ssr/code-schedule";
import { Button, Placeholder, ScrollArea, Skeleton, StatusBadge, type StatusTone, useLocale } from "@k2b/ui";
import { createSignal, For, onMount, Show } from "solid-js";
import {
  type CodeRunCount,
  type CodeStatusKey,
  type CodeStatusTone,
  type CodeSummary,
  type CodeSummaryPage,
  codeStatus,
  countOwnRunsSince,
  loadCodeSummaries,
  nextCodeRun,
  startOfDayIn,
} from "../code-summary";
import { browserCodeInvoke, formatCodeNextRun, formatCodeTime } from "./code-client";
import { assistantMessages } from "./messages";

const badgeTone: Record<CodeStatusTone, StatusTone> = { success: "ok", warning: "warning", danger: "error", neutral: "neutral" };

export function CodeStatusBadge(props: { code: CodeSummary; status?: { key: CodeStatusKey; tone: CodeStatusTone } }) {
  const locale = useLocale();
  const status = () => props.status ?? codeStatus(props.code);
  return <StatusBadge tone={badgeTone[status().tone]} variant="dot" label={codeStateLabel(status().key, locale())} />;
}

/** The visible word for one Code status. */
export const codeStateLabel = (key: CodeStatusKey, locale: string) => {
  const t = assistantMessages.resolve([locale]).t;
  return {
    on: t.codeStateOn,
    paused: t.codeStatePaused,
    draft: t.codeStateDraft,
    deleting: t.codeStateDeleting,
    failed: t.codeStateFailed,
    access_missing: t.codeStateAccessMissing,
  }[key];
};

/** When the newest run ended or started, that none ran yet, or that Core could not say. */
export const codeRunTime = (code: CodeSummary, locale: string, timeZone: string) => {
  const t = assistantMessages.resolve([locale]).t;
  const run = code.lastRun;
  if (run === undefined) return t.codeRunUnknown;
  return run ? formatCodeTime(run.endedAt ?? run.createdAt, locale, timeZone) : t.codeNoRun;
};

/** The line under a Code's name in the panel block: its newest run. */
export const codeRunLine = (code: CodeSummary, locale: string, timeZone: string) => {
  const t = assistantMessages.resolve([locale]).t;
  return code.lastRun ? t.codeLastRun({ when: codeRunTime(code, locale, timeZone) }) : codeRunTime(code, locale, timeZone);
};

/**
 * The line under a Code's name in the list: what kind it is, its schedule, and when it runs next. A Code with several
 * automations names their number; the next run is the earliest of them. Without automations it only says its kind.
 */
export const codeScheduleLine = (code: CodeSummary, locale: string, timeZone: string) => {
  const t = assistantMessages.resolve([locale]).t;
  const automations = code.automations ?? [];
  const single = automations.length === 1 ? automations[0]! : null;
  const next = nextCodeRun(code);
  return [
    automations.length > 1 ? t.codeAutomationCount({ count: automations.length }) : t.codeKind,
    ...(single ? [single.cron ? describeCodeSchedule(single.cron, locale) : t.codeManualStart] : []),
    ...(next ? [t.codeNextRun({ when: formatCodeNextRun(next, locale, timeZone) })] : []),
  ].join(" · ");
};

/**
 * "My apps & automations": only the person's own Code, which runs as them. Code of a place stays at that place.
 * `initial` is the server's first page (null when it failed); without it, the list loads when the view opens.
 */
export default function AssistantCodeView(props: {
  userId: string;
  timeZone: string;
  initial?: CodeSummaryPage | null;
  /** Today's runs from the server; null when Core could not count them, undefined to count in the browser. */
  initialToday?: CodeRunCount | null;
  onCreateInChat: () => void;
}) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const [page, setPage] = createSignal<CodeSummaryPage | null | undefined>(props.initial);
  const [more, setMore] = createSignal<"idle" | "loading" | "failed">("idle");
  // A missing count leaves the line without numbers; the list itself is unaffected.
  const [today, setToday] = createSignal<CodeRunCount | null | undefined>(props.initialToday);
  // Further pages append below; a failed page keeps what is shown and offers the same request again.
  const loadMore = async () => {
    const current = page();
    if (!current?.nextCursor || more() === "loading") return;
    setMore("loading");
    try {
      const next = await loadCodeSummaries(browserCodeInvoke, { kind: "person", userId: props.userId }, current.nextCursor);
      setPage({ items: [...current.items, ...next.items], nextCursor: next.nextCursor });
      setMore("idle");
    } catch {
      setMore("failed");
    }
  };
  const count = async () => {
    setToday(undefined);
    try {
      setToday(await countOwnRunsSince(browserCodeInvoke, startOfDayIn(props.timeZone, new Date())));
    } catch {
      setToday(null);
    }
  };
  const load = async () => {
    setPage(undefined);
    if (today() === null) void count();
    try {
      setPage(await loadCodeSummaries(browserCodeInvoke, { kind: "person", userId: props.userId }));
    } catch {
      setPage(null);
    }
  };
  onMount(() => {
    if (props.initial === undefined) void load();
    if (props.initialToday === undefined) void count();
  });
  const createButton = () => (
    <Button type="button" variant="primary" onClick={() => props.onCreateInChat()}>
      <i class="ti ti-moustache" aria-hidden="true" />
      {t().codeCreateInChat}
    </Button>
  );

  return (
    <ScrollArea class="min-h-0 flex-1 p-[var(--ui-space-section)]">
      <section class="assistant-code mx-auto flex w-full max-w-3xl flex-col gap-4 pb-8" aria-labelledby="assistant-code-title">
        {/* The sidebar marks this place, so the heading is for screen readers; the line and the action lead. */}
        <h1 id="assistant-code-title" class="sr-only">
          {t().myCode}
        </h1>
        <header class="flex min-w-0 flex-wrap items-center gap-3">
          <p class="assistant-code__lead min-w-0 flex-1 text-sm text-secondary">
            <i class="ti ti-moustache" aria-hidden="true" />
            {t().codeRunsAsYou}
            <Show when={today()}>{(current) => <span>{t().codeToday(current())}</span>}</Show>
            <Show when={today() === null}>
              <span class="assistant-code__today-failed">
                {t().codeTodayFailed}
                <Button type="button" size="xs" variant="text" onClick={() => void count()}>
                  {t().codeBlockRetry}
                </Button>
              </span>
            </Show>
          </p>
          {createButton()}
        </header>
        <Show
          when={page() !== undefined}
          fallback={
            <div class="assistant-code__list" role="status" aria-busy="true" aria-label={t().codeName}>
              <For each={[0, 1, 2, 3]}>
                {() => (
                  <div class="assistant-code__row">
                    <Skeleton class="h-7 w-7 rounded-md" />
                    <span class="flex min-w-0 flex-col gap-1.5">
                      <Skeleton class="h-3 w-3/5" />
                      <Skeleton class="h-2.5 w-2/5" />
                    </span>
                    <Skeleton class="assistant-code__wide h-2.5 w-24" />
                    <Skeleton class="assistant-code__wide h-2.5 w-16" />
                  </div>
                )}
              </For>
            </div>
          }
        >
          <Show
            when={page()}
            fallback={
              <Placeholder
                state="error"
                variant="panel"
                icon="ti ti-cloud-off"
                title={t().codeLoadFailed}
                description={t().codeLoadFailedHint}
                onRetry={() => void load()}
              />
            }
          >
            {(current) => (
              <Show
                when={current().items.length > 0}
                fallback={
                  <Placeholder
                    variant="panel"
                    icon="ti ti-stack-2"
                    title={t().codeEmpty}
                    description={t().codeEmptyHint}
                    action={createButton()}
                  />
                }
              >
                <div class="assistant-code__list">
                  <div class="assistant-code__row assistant-code__head" aria-hidden="true">
                    <span />
                    <span>{t().codeName}</span>
                    <span class="assistant-code__wide">{t().codeLast}</span>
                    <span class="assistant-code__wide">{t().codeStatus}</span>
                  </div>
                  <ul class="contents">
                    <For each={current().items}>
                      {(code) => (
                        <li class="assistant-code__row">
                          <span class="assistant-code__kind" aria-hidden="true">
                            <i class="ti ti-bolt" />
                          </span>
                          <span class="flex min-w-0 flex-col">
                            <a class="assistant-code__name truncate font-medium text-primary" href={`/app/assistant/code/${code.id}`}>
                              {code.title}
                            </a>
                            <span class="text-sm text-secondary">{codeScheduleLine(code, locale(), props.timeZone)}</span>
                            <span class="assistant-code__narrow">
                              <CodeStatusBadge code={code} />
                            </span>
                          </span>
                          <span class="assistant-code__wide text-sm text-secondary">{codeRunTime(code, locale(), props.timeZone)}</span>
                          <span class="assistant-code__wide">
                            <CodeStatusBadge code={code} />
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
                <Show when={current().nextCursor}>
                  <div class="flex flex-wrap items-center gap-3">
                    <Button type="button" variant="secondary" size="sm" loading={more() === "loading"} onClick={() => void loadMore()}>
                      {t().codeLoadMore}
                    </Button>
                    <Show when={more() === "failed"}>
                      <span role="alert" class="text-sm text-danger">
                        {t().codeLoadMoreFailed}
                      </span>
                    </Show>
                  </div>
                </Show>
              </Show>
            )}
          </Show>
        </Show>
        <p class="max-w-[40rem] text-sm text-secondary">{t().codeElsewhere}</p>
      </section>
    </ScrollArea>
  );
}
