import Approvals from "@k2b/cloud/approvals/list";
import { coreClient } from "@k2b/cloud/clients/core";
import { type ApprovalPage, ApprovalPageSchema } from "@k2b/cloud/contracts/approvals";
import { Placeholder, ScrollArea, Skeleton, useLocale } from "@k2b/ui";
import { createSignal, For, onMount, Show } from "solid-js";
import AssistantCodeAttention, { type CodeAttentionView, loadCodeAttentionView } from "./AssistantCodeAttention";
import { assistantMessages } from "./messages";

const loadApprovalPage = async (): Promise<ApprovalPage> => {
  const response = await coreClient.approvals.$get({ query: { app: "assistant" } });
  if (!response.ok) throw new Error(`Approvals answered ${response.status}`);
  return ApprovalPageSchema.parse(await response.json());
};

/**
 * Waiting for you: what Gustav asked for in chats, whichever app owns the effect, each with the shared approval card
 * and the chat it came from; below, Code of a place the person administers when it needs them. The server seeds both
 * lists; without a seed, they load when the page opens. Nothing on this page decides anything by itself.
 */
export default function AssistantApprovalsView(props: {
  /** The server's first page; null when it could not be read. */
  initial?: ApprovalPage | null;
  initialAttention?: CodeAttentionView | null;
}) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const [approvals, setApprovals] = createSignal<ApprovalPage | null | undefined>(props.initial);
  const [attention, setAttention] = createSignal<CodeAttentionView | null | undefined>(props.initialAttention);
  const [more, setMore] = createSignal<"idle" | "loading" | "failed">("idle");
  const loadApprovals = async () => {
    setApprovals(undefined);
    try {
      setApprovals(await loadApprovalPage());
    } catch {
      setApprovals(null);
    }
  };
  const loadAttention = async () => {
    setAttention(undefined);
    try {
      setAttention(await loadCodeAttentionView());
    } catch {
      setAttention(null);
    }
  };
  // Core checks Code in bounded windows; the person continues where the last check stopped.
  const loadMoreAttention = async () => {
    const current = attention();
    if (!current?.nextCursor || more() === "loading") return;
    setMore("loading");
    try {
      const next = await loadCodeAttentionView(current.nextCursor);
      setAttention({ items: [...current.items, ...next.items], nextCursor: next.nextCursor });
      setMore("idle");
    } catch {
      setMore("failed");
    }
  };
  onMount(() => {
    if (props.initial === undefined) void loadApprovals();
    if (props.initialAttention === undefined) void loadAttention();
  });
  const retry = () => {
    void loadApprovals();
    if (attention() === null) void loadAttention();
  };

  const loading = () => approvals() === undefined || attention() === undefined;
  const attentionShows = () => {
    const view = attention();
    return view === null || Boolean(view && (view.items.length > 0 || view.nextCursor));
  };
  const empty = () => (approvals()?.count ?? 0) === 0 && approvals() !== null && !attentionShows();

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
                    <Approvals app="assistant" initial={page()} />
                  </section>
                </Show>
                <Show when={attentionShows()}>
                  <AssistantCodeAttention
                    view={attention() ?? null}
                    more={more()}
                    onRetry={() => void loadAttention()}
                    onMore={() => void loadMoreAttention()}
                  />
                </Show>
              </Show>
            )}
          </Show>
        </Show>
      </section>
    </ScrollArea>
  );
}
