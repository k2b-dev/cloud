import { Button, Placeholder, ScrollArea, Skeleton, StatusBadge, type StatusTone, useLocale } from "@k2b/ui";
import { createSignal, For, onMount, Show } from "solid-js";
import { type CodeStatusTone, type CodeSummary, type CodeSummaryPage, codeStatus, loadCodeSummaries } from "../code-summary";
import { browserCodeInvoke, formatCodeTime } from "./code-client";
import { assistantMessages } from "./messages";

const badgeTone: Record<CodeStatusTone, StatusTone> = { success: "ok", warning: "warning", danger: "error", neutral: "neutral" };

export function CodeStatusBadge(props: { code: CodeSummary }) {
  const locale = useLocale();
  const status = () => codeStatus(props.code);
  return <StatusBadge tone={badgeTone[status().tone]} variant="text" label={codeStateLabel(status().key, locale())} />;
}

/** The visible word for one Code status. */
export const codeStateLabel = (key: ReturnType<typeof codeStatus>["key"], locale: string) => {
  const t = assistantMessages.resolve([locale]).t;
  return {
    on: t.codeStateOn,
    paused: t.codeStatePaused,
    draft: t.codeStateDraft,
    deleting: t.codeStateDeleting,
    failed: t.codeStateFailed,
  }[key];
};

/** When the newest run ended or started, or that none ran yet. */
export const codeRunTime = (code: CodeSummary, locale: string, timeZone: string) => {
  const run = code.lastRun;
  return run ? formatCodeTime(run.endedAt ?? run.createdAt, locale, timeZone) : assistantMessages.resolve([locale]).t.codeNoRun;
};

/** The line under a Code's name in the panel block: its newest run. */
export const codeRunLine = (code: CodeSummary, locale: string, timeZone: string) => {
  const t = assistantMessages.resolve([locale]).t;
  return code.lastRun ? t.codeLastRun({ when: codeRunTime(code, locale, timeZone) }) : t.codeNoRun;
};

/**
 * "My apps & automations": only the person's own Code, which runs as them. Code of a place stays at that place.
 * `initial` is the server's first page (null when it failed); without it, the list loads when the view opens.
 */
export default function AssistantCodeView(props: {
  userId: string;
  timeZone: string;
  initial?: CodeSummaryPage | null;
  onCreateInChat: () => void;
}) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const [page, setPage] = createSignal<CodeSummaryPage | null | undefined>(props.initial);
  const load = async () => {
    setPage(undefined);
    try {
      setPage(await loadCodeSummaries(browserCodeInvoke, { kind: "person", userId: props.userId }));
    } catch {
      setPage(null);
    }
  };
  onMount(() => {
    if (props.initial === undefined) void load();
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
        <header class="flex min-w-0 flex-wrap items-start gap-3">
          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <h1 id="assistant-code-title" class="text-xl font-semibold text-primary">
              {t().myCode}
            </h1>
            <p class="assistant-code__lead text-sm text-secondary">
              <i class="ti ti-moustache" aria-hidden="true" />
              {t().codeRunsAsYou}
            </p>
          </div>
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
                            <span class="truncate font-medium text-primary">{code.title}</span>
                            <span class="truncate text-sm text-secondary">{t().codeKind}</span>
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
                <Show when={current().more}>
                  <p class="text-sm text-secondary">{t().codeMore({ count: current().items.length })}</p>
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
