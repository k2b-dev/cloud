import type { AiOpenQuestion, AiOpenQuestions } from "@k2b/cloud/ai";
import Approvals from "@k2b/cloud/approvals/list";
import { importOnDemand } from "@k2b/cloud/browser/reload";
import { coreClient } from "@k2b/cloud/clients/core";
import { type ApprovalPage, ApprovalPageSchema } from "@k2b/cloud/contracts/approvals";
import { Button, Paper, Placeholder, ScrollArea, Skeleton, useLocale } from "@k2b/ui";
import { type Accessor, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import type { WaitingAutomation } from "../waiting-automations";
import type { WaitingQuestionsPagingState } from "../waiting-questions-page";
import AssistantWaitingAutomations from "./AssistantWaitingAutomations";
import { WAITING_KIND_ICON } from "./AssistantWaitingStrip";
import { browserCodeInvoke } from "./code-client";
import { assistantMessages } from "./messages";

const loadApprovalPage = async (): Promise<ApprovalPage> => {
  const response = await coreClient.approvals.$get({ query: { app: "assistant" } });
  if (!response.ok) throw new Error(`Approvals answered ${response.status}`);
  return ApprovalPageSchema.parse(await response.json());
};

/** Kinds of the person's open questions that are versions of their own Code, such as "Switch on version 2". */
const VERSION_KINDS: ReadonlySet<AiOpenQuestion["kind"]> = new Set(["code_activate", "code_changes", "code_expired"]);

/**
 * Waiting for you: the same things as the "Waiting for you" row above the field and its count, by kind. Approvals each
 * with the shared approval card and the chat it came from; versions of the person's own Code, each leading to its card
 * in the chat; then automations that need the person. Versions come from the row's own list, so page, row and count
 * show the same entries and change together. The server seeds every list; without a seed, approvals and automations
 * load when the page opens. Nothing on this page decides anything by itself.
 */
export default function AssistantApprovalsView(props: {
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
}) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const [paging, setPaging] = createSignal<WaitingQuestionsPagingState>({ items: [], cursor: props.questionsPage?.().nextCursor });
  const extraQuestions = createMemo(() => paging().items);
  let pageController = new AbortController();
  onCleanup(() => pageController.abort());
  createEffect(
    on(
      () => props.questionsPage?.(),
      (page) => {
        pageController.abort();
        pageController = new AbortController();
        setPaging({ items: [], cursor: page?.nextCursor });
      },
      { defer: true },
    ),
  );
  const loadMore = async () => {
    const current = paging();
    if (!current.cursor || current.loading) return;
    const signal = pageController.signal;
    setPaging({ ...current, loading: true, failed: false });
    const module = await importOnDemand(() => import("../waiting-questions-page"));
    if (signal.aborted) return;
    if (module) await module.loadMoreWaitingQuestions(current, setPaging, props.timeZone, signal);
    else setPaging({ ...current, failed: true });
  };
  const allQuestions = createMemo(() => [...new Map([...props.questions(), ...extraQuestions()].map((item) => [item.id, item])).values()]);
  const [approvals, setApprovals] = createSignal<ApprovalPage | null | undefined>(props.initial);
  const [automations, setAutomations] = createSignal<readonly WaitingAutomation[] | null | undefined>(props.initialAutomations);
  const loadApprovals = async () => {
    setApprovals(undefined);
    try {
      showApprovals(await loadApprovalPage());
    } catch {
      setApprovals(null);
    }
  };
  // Only a page without the server's read needs the loader; it stays out of the chat's own bundle.
  const readAutomations = async () => (await import("../waiting-automations")).loadWaitingAutomations(browserCodeInvoke, props.timeZone);
  const loadAutomations = async () => {
    setAutomations(undefined);
    try {
      setAutomations(await readAutomations());
    } catch {
      setAutomations(null);
    }
  };
  // Approvals and automations have reads of their own; the row's list says when theirs changed. Both read again in
  // place, without a loading state, and a failed read keeps what the page shows.
  // Approvals read again only for a request the page has not seen yet. A request that leaves the list, such as one
  // decided here, keeps its card as a receipt until the next real load, so nothing moves under the person's click.
  const seenApprovals = new Set<string>();
  const showApprovals = (page: ApprovalPage | null | undefined) => {
    for (const item of page?.items ?? []) seenApprovals.add(item.id);
    setApprovals(page);
  };
  const approvalIds = createMemo(
    () =>
      props
        .questions()
        .filter((question) => question.kind === "approval")
        .map((question) => question.id),
    [],
    { equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]) },
  );
  for (const id of untrack(approvalIds)) seenApprovals.add(id);
  for (const item of props.initial?.items ?? []) seenApprovals.add(item.id);
  let approvalRead = 0;
  createEffect(
    on(
      approvalIds,
      (ids) => {
        const fresh = ids.filter((id) => !seenApprovals.has(id));
        if (fresh.length === 0) return;
        for (const id of fresh) seenApprovals.add(id);
        const request = ++approvalRead;
        loadApprovalPage().then(
          (page) => {
            if (request === approvalRead && approvals() !== undefined) showApprovals(page);
          },
          () => {},
        );
      },
      { defer: true },
    ),
  );
  // Automations read again on any change of theirs: their rows carry no decision of their own.
  const automationKey = createMemo(() =>
    props
      .questions()
      .filter((question) => question.kind === "code_attention")
      .map((question) => question.id)
      .sort()
      .join(" "),
  );
  let automationRead = 0;
  createEffect(
    on(
      automationKey,
      () => {
        const request = ++automationRead;
        readAutomations().then(
          (list) => {
            if (request === automationRead && automations() !== undefined) setAutomations(list);
          },
          () => {},
        );
      },
      { defer: true },
    ),
  );
  onMount(() => {
    if (props.initial === undefined) void loadApprovals();
    if (props.initialAutomations === undefined) void loadAutomations();
  });
  const retry = () => {
    void loadApprovals();
    if (automations() === null) void loadAutomations();
  };

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
                    onRetry={() => void loadAutomations()}
                    // A read that fails after the restore shows the section's error with "Try again", never silence.
                    onChanged={() =>
                      readAutomations().then(
                        (list) => void setAutomations(list),
                        () => void setAutomations(null),
                      )
                    }
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
