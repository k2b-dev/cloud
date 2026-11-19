import type { AiOpenQuestion, AiOpenQuestions } from "@k2b/cloud/ai";
import Approvals from "@k2b/cloud/approvals/list";
import { importOnDemand } from "@k2b/cloud/browser/reload";
import type { ApprovalPage } from "@k2b/cloud/contracts/approvals";
import { Button, Paper, Placeholder, ScrollArea, Skeleton, useLocale } from "@k2b/ui";
import { type Accessor, createMemo, createSignal, For, getOwner, onCleanup, onMount, runWithOwner, Show, untrack } from "solid-js";
import type { WaitingAutomation } from "../waiting-automations";
import type { WaitingQuestionsController, WaitingQuestionsPagingState } from "../waiting-questions-page";
import AssistantWaitingAutomations from "./AssistantWaitingAutomations";
import { WAITING_KIND_ICON } from "./AssistantWaitingStrip";
import { assistantMessages } from "./messages";

/** Kinds of the person's open questions that are versions of their own Code, such as "Switch on version 2". */
const VERSION_KINDS: ReadonlySet<AiOpenQuestion["kind"]> = new Set(["code_activate", "code_changes", "code_expired"]);

/**
 * Waiting for you: the same things as the "Waiting for you" row above the field and its count, by kind. Approvals each
 * with the shared approval card and the chat it came from; versions of the person's own Code, each leading to its card
 * in the chat; then automations that need the person. Versions come from the row's own list, so page, row and count
 * show the same entries and change together. The server seeds every list; without a seed, approvals and automations
 * load when the page opens. Nothing on this page decides anything by itself.
 */
export type AssistantApprovalsViewProps = {
  /** The server's first page; null when it could not be read. */
  initial?: ApprovalPage | null;
  /** The person's open questions as the row above the field shows them (`waitingQuestionsView`). */
  questions: Accessor<readonly AiOpenQuestion[]>;
  /** The shared SSR snapshot, including its continuation beyond the strip's first page. */
  questionsPage?: Accessor<AiOpenQuestions>;
  /** Goes to a question's card, as a press on the row's entry does. */
  onJump: (question: AiOpenQuestion) => void;
  /** The person's own Code that waits for them (Core's `code_attention` questions); null when it could not be read. */
  initialAutomations?: readonly WaitingAutomation[] | null;
  /** The reader's time zone, which Core's open questions take. */
  timeZone: string;
};

export default function AssistantApprovalsView(props: AssistantApprovalsViewProps) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const [paging, setPaging] = createSignal<WaitingQuestionsPagingState>({ items: [], cursor: props.questionsPage?.().nextCursor });
  const extraQuestions = createMemo(() => paging().items);
  const [approvals, setApprovals] = createSignal<ApprovalPage | null | undefined>(props.initial);
  const [automations, setAutomations] = createSignal<readonly WaitingAutomation[] | null | undefined>(props.initialAutomations);
  const owner = getOwner();
  const initialQuestions = untrack(props.questions);
  const initialPage = props.questionsPage?.();
  let active = true;
  let pending: Promise<WaitingQuestionsController | undefined> | undefined;
  onCleanup(() => {
    active = false;
  });
  const controller = () =>
    (pending ??= importOnDemand(async () => {
      const module = await import("../waiting-questions-page");
      if (!active) return;
      return runWithOwner(owner, () =>
        module.connectWaitingQuestions(
          props,
          {
            approvals,
            setApprovals,
            automations,
            setAutomations,
            paging,
            setPaging,
          },
          initialQuestions,
          initialPage,
        ),
      );
    }).then((loaded) => {
      if (!loaded) pending = undefined;
      return loaded;
    }));
  onMount(
    () =>
      void controller().then((loaded) => {
        if (!loaded && active) {
          if (approvals() === undefined) setApprovals(null);
          if (automations() === undefined) setAutomations(null);
        }
      }),
  );
  const loadMore = async () => {
    const current = paging();
    if (!current.cursor || current.loading) return;
    setPaging({ ...current, loading: true, failed: false });
    const loaded = await controller();
    if (!active) return;
    if (loaded) await loaded.loadMore();
    else setPaging({ ...current, failed: true });
  };
  const allQuestions = createMemo(() => [...new Map([...props.questions(), ...extraQuestions()].map((item) => [item.id, item])).values()]);
  const retry = () => void controller().then((loaded) => loaded?.retry());

  const loading = () => approvals() === undefined || automations() === undefined;
  const versions = createMemo(() => allQuestions().filter((question) => VERSION_KINDS.has(question.kind)));
  // A failed read shows its row with "Try again"; an empty one shows no section.
  const shownAutomations = createMemo(() =>
    automations() == null
      ? automations()
      : [
          ...new Map(
            [
              ...automations()!,
              ...extraQuestions()
                .filter((question) => question.kind === "code_attention")
                .map((question) => ({ ...question, kind: "code_attention" as const })),
            ].map((item) => [item.id, item]),
          ).values(),
        ],
  );
  const automationsShow = () => shownAutomations() === null || (shownAutomations()?.length ?? 0) > 0;
  const empty = () =>
    (approvals()?.count ?? 0) === 0 && approvals() !== null && versions().length === 0 && !automationsShow() && !paging().cursor;

  return (
    <ScrollArea class="min-h-0 flex-1">
      <section class="assistant-waiting-page" aria-labelledby="assistant-waiting-title">
        <header class="assistant-page-head">
          <div class="assistant-page-head__copy">
            <h1 id="assistant-waiting-title" class="assistant-page-head__title">
              {t().waitingForYou}
            </h1>
            <p class="assistant-page-head__lead">{t().waitingLead}</p>
          </div>
        </header>
        <Show
          when={!loading()}
          fallback={
            <div class="assistant-waiting-page__section" role="status" aria-busy="true" aria-label={t().waitingLoading}>
              <h2 class="assistant-waiting-page__heading">{t().waitingApprovals}</h2>
              <For each={[0, 1]}>
                {() => (
                  <div class="k2b-paper assistant-waiting-page__skeleton" aria-hidden="true">
                    <Skeleton class="h-3 w-1/3" />
                    <Skeleton class="h-4 w-3/5" />
                    <Skeleton class="h-3 w-2/5" />
                    <span class="assistant-waiting-page__skeleton-actions">
                      <Skeleton class="h-8 w-24" />
                      <Skeleton class="h-8 w-24" />
                    </span>
                  </div>
                )}
              </For>
            </div>
          }
        >
          <Show
            when={approvals()}
            fallback={
              <Placeholder
                state="error"
                variant="panel"
                icon="ti ti-cloud-off"
                title={t().waitingFailed}
                description={t().waitingFailedHint}
                onRetry={retry}
              />
            }
          >
            {(page) => (
              <Show
                when={!empty()}
                fallback={
                  <Placeholder variant="panel" icon="ti ti-mood-check" title={t().waitingEmpty} description={t().waitingEmptyHint} />
                }
              >
                <Show when={page().count > 0}>
                  <section class="assistant-waiting-page__section" aria-labelledby="assistant-waiting-approvals">
                    <h2 id="assistant-waiting-approvals" class="assistant-waiting-page__heading">
                      {t().waitingApprovals} <span class="assistant-waiting-page__count">{page().count}</span>
                    </h2>
                    {/* Keyed by the page read: only a read for a new request replaces the list and its receipts. */}
                    <Show when={page()} keyed>
                      {(current) => <Approvals app="assistant" initial={current} />}
                    </Show>
                  </section>
                </Show>
                <Show when={versions().length > 0}>
                  <section class="assistant-waiting-page__section" aria-labelledby="assistant-waiting-versions">
                    <h2 id="assistant-waiting-versions" class="assistant-waiting-page__heading">
                      {t().waitingVersions} <span class="assistant-waiting-page__count">{versions().length}</span>
                    </h2>
                    <Paper class="assistant-waiting-page__rows">
                      <ul class="assistant-waiting-page__list">
                        <For each={versions()}>
                          {(question) => (
                            <li class="assistant-waiting-page__row" data-kind={question.kind}>
                              <span class="assistant-waiting-page__tile" aria-hidden="true">
                                <i class={WAITING_KIND_ICON[question.kind]} />
                              </span>
                              <span class="assistant-waiting-page__row-copy">
                                <span class="assistant-waiting-page__row-title">{question.short}</span>
                                <Show when={question.conversationTitle}>
                                  {(title) => <span class="assistant-waiting-page__row-sub">{t().waitingInChat({ title: title() })}</span>}
                                </Show>
                              </span>
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                class="assistant-waiting-page__open"
                                aria-label={t().waitingViewLabel({ title: question.short })}
                                onClick={() => props.onJump(question)}
                              >
                                {t().waitingView}
                              </Button>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Paper>
                  </section>
                </Show>
                <Show when={automationsShow()}>
                  <AssistantWaitingAutomations
                    entries={shownAutomations() ?? null}
                    onRetry={() => void controller().then((loaded) => loaded?.loadAutomations())}
                    // A read that fails after the restore shows the section's error with "Try again", never silence.
                    onChanged={async () => {
                      await (await controller())?.refreshAutomations();
                    }}
                  />
                </Show>
              </Show>
            )}
          </Show>
        </Show>
        <Show when={paging().cursor}>
          <div class="assistant-waiting-page__section">
            <Show when={paging().failed}>
              <p role="alert">{t().waitingFailed}</p>
            </Show>
            <Button type="button" variant="secondary" loading={paging().loading} onClick={() => void loadMore()}>
              {paging().failed ? t().codeViewRetry : t().waitingLoadMore}
            </Button>
          </div>
        </Show>
      </section>
    </ScrollArea>
  );
}
