import { dates } from "@k2b/stdlib";
import { Button, Placeholder, prompts, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { FeatCodeMark } from "../code/FeatCodeMark";
import { APPROVALS_PAGE_PATH, type ApprovalPage, type PendingApproval } from "../contracts/approvals";
import { approvalCard } from "./approval-card";
import { ApprovalEntry, type ApprovalEntryProps, approvalOrigin, useApprovalMessages } from "./approval-entry";
import { approvalCardInput, createApprovalList, READER_TIME_ZONE } from "./approval-list";
import { ARM_DELAY_MS } from "./approval-place";

export type ApprovalsProps = {
  /** List the requests whose effect belongs to this app or that this app asked for. Without, every app's, grouped. */
  app?: string;
  /**
   * Only requests whose review links to this same-origin path, such as the page of the draft a send would send. Such a
   * list sits beside the resource and shows nothing while no request waits.
   */
  link?: string;
  /** The first page for the same query, loaded during SSR with `loadPendingApprovals`; without, the browser loads it. */
  initial?: ApprovalPage;
};

const useMessages = useApprovalMessages;

/** Origin of the request: the chat or Code version it waits in and when Cloud asked. The card shows the app and expiry. */
function Origin(props: { item: PendingApproval }) {
  const t = useMessages();
  const locale = useLocale();
  const automation = () => props.item.requester.automation;
  return (
    <p class="cloud-approval__origin">
      <Show
        when={automation()}
        fallback={<i class={props.item.requester.kind === "code_version" ? "ti ti-code" : "ti ti-message-circle"} aria-hidden="true" />}
      >
        {(source) => (
          <>
            <FeatCodeMark variant="glyph" tone="current" decorative />
            <a href={source().href}>{t().fromAutomation({ title: source().title })}</a>
            <span aria-hidden="true"> · </span>
          </>
        )}
      </Show>
      <a href={props.item.requester.href}>
        <Show when={props.item.requester.kind === "code_version"}>
          <FeatCodeMark variant="glyph" decorative class="cloud-approval__origin-mark" />
        </Show>
        {approvalOrigin(props.item, t())}
      </a>
      <span aria-hidden="true"> · </span>
      <time dateTime={props.item.createdAt}>{dates.formatDateTimeRelative(props.item.createdAt, { locale: locale() })}</time>
    </p>
  );
}

/** Answers that arm late, so a click meant for what was there before cannot approve a request that just appeared. */
function Armed(props: { children: JSX.Element }) {
  const [armed, setArmed] = createSignal(false);
  onMount(() => {
    const timer = setTimeout(() => setArmed(true), ARM_DELAY_MS);
    onCleanup(() => clearTimeout(timer));
  });
  return <div inert={armed() ? undefined : true}>{props.children}</div>;
}

/** One request as Cloud's approval, under where it comes from. Its answers arm late, so a click meant for the page cannot approve it. */
function Row(props: ApprovalEntryProps) {
  const t = useMessages();
  const locale = useLocale();
  const card = createMemo(() => approvalCard(approvalCardInput(props.item), locale(), READER_TIME_ZONE));
  return (
    <article class="cloud-approval" data-decided={props.outcome} aria-label={t().approvalFor({ title: card().questionText })}>
      <Origin item={props.item} />
      <Armed>
        <ApprovalEntry {...props} card={card()} />
      </Armed>
    </article>
  );
}

/**
 * Open Action approvals of the signed-in person, as every app lists and decides them. Rows that someone decides stay
 * in place, at their height, as a receipt; the list only changes when it loads again.
 */
export default function Approvals(props: ApprovalsProps) {
  const t = useMessages();
  const list = createApprovalList(props, (targets) =>
    prompts.confirm(
      targets.some((item) => item.requester.kind === "code_version")
        ? t().rejectAllWithVersions
        : t().rejectAllBody({ count: targets.length }),
      {
        title: t().rejectAllTitle,
        confirmText: t().rejectAll,
        variant: "danger",
      },
    ),
  );
  const { page, items, outcomes, busy, failed, loadError, loadingMore, moreError, reload, loadMore, open, openCount, rejectAll, groups } =
    list;
  const rows = (entries: PendingApproval[]) => (
    <For each={entries}>
      {(item) => (
        <Row
          item={list.withEdit(item)}
          editDraft={list.editDraft(item)}
          outcome={outcomes().get(item.id)}
          busy={busy().has(item.id)}
          failed={failed().get(item.id) ?? false}
          decide={(input) => void list.decide(item, input)}
          retry={() => list.retry(item)}
          reopen={() => list.reopen(item)}
        />
      )}
    </For>
  );
  return (
    // A list beside one resource stays out of the way until a request for it waits.
    <Show when={!props.link || items().length > 0}>
      <section class="cloud-approvals" aria-label={t().title}>
        <Show
          when={page()}
          fallback={
            <Show when={loadError()} fallback={<Placeholder state="loading" title={t().loading} variant="panel" />}>
              <Placeholder
                state="error"
                title={t().loadFailed}
                variant="panel"
                action={
                  <Button size="sm" variant="secondary" onClick={() => void reload()}>
                    {t().retry}
                  </Button>
                }
              />
            </Show>
          }
        >
          <Show
            when={items().length > 0}
            fallback={<Placeholder icon="ti ti-circle-check" title={t().emptyTitle} description={t().emptyBody} variant="panel" />}
          >
            {/* A single request needs no count: the card is the count, and the navigation already shows it. The row
                depends on the shown requests, which stay in place when decided, so deciding never moves the list. */}
            <Show when={!props.link && items().length > 1}>
              <div class="cloud-approvals__toolbar">
                <span>{t().open({ count: openCount() })}</span>
                <Show when={open().length > 1}>
                  <Button size="sm" variant="ghost" onClick={() => void rejectAll()}>
                    <i class="ti ti-x" aria-hidden="true" />
                    {t().rejectAll}
                  </Button>
                </Show>
              </div>
            </Show>
            <Show
              when={props.app || props.link}
              fallback={<For each={groups()}>{(group) => <AppGroup items={group}>{rows(group)}</AppGroup>}</For>}
            >
              <div class="cloud-approvals__list">{rows(items())}</div>
            </Show>
            <Show when={page()?.nextCursor}>
              <div class="cloud-approvals__more">
                <Show when={moreError()}>
                  <p class="cloud-approvals__more-error" role="alert">
                    <i class="ti ti-alert-circle" aria-hidden="true" />
                    {t().loadMoreFailed}
                  </p>
                </Show>
                <Button size="sm" variant="link" loading={loadingMore()} onClick={() => void loadMore()}>
                  {moreError() ? t().retry : t().showMore}
                  <i class={moreError() ? "ti ti-refresh" : "ti ti-chevron-down"} aria-hidden="true" />
                </Button>
              </div>
            </Show>
          </Show>
          <Show when={(page()?.elsewhere ?? 0) > 0}>
            <p class="cloud-approvals__elsewhere">
              <span>{t().elsewhere({ count: page()?.elsewhere ?? 0 })}</span>
              <a href={APPROVALS_PAGE_PATH}>
                {t().allApprovals}
                <i class="ti ti-arrow-up-right" aria-hidden="true" />
              </a>
            </p>
          </Show>
        </Show>
      </section>
    </Show>
  );
}

function AppGroup(props: { items: PendingApproval[]; children: JSX.Element }) {
  const app = () => props.items[0]?.app;
  return (
    <section class="cloud-approvals__group" aria-label={app()?.name}>
      <h2 class="cloud-approvals__group-title">
        <i class={app()?.icon ?? "ti ti-apps"} aria-hidden="true" />
        {app()?.name}
      </h2>
      <div class="cloud-approvals__list">{props.children}</div>
    </section>
  );
}
