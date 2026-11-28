import { useLocale } from "@k2b/ui";
import { Bar, Button, confirm, Empty, Failed, List, Loading, Row, Section, Text } from "@k2b/ui/v2";
import { createMemo, For, Show } from "solid-js";
import { APPROVALS_PAGE_PATH, type PendingApproval } from "../contracts/approvals";
import { ApprovalFrameV2 } from "./ApprovalFrameV2";
import type { ApprovalsProps } from "./Approvals";
import { approvalCard } from "./approval-card";
import { ApprovalEntry, type ApprovalEntryProps, approvalOrigin, useApprovalMessages } from "./approval-entry";
import { approvalCardInput, createApprovalList, READER_TIME_ZONE } from "./approval-list";
import { type ApprovalPlace, ApprovalPlaceContext } from "./approval-place";

/** A v2 icon name from a v1 icon class such as `ti ti-mail`. */
const iconName = (icon: string | null | undefined) => icon?.replace(/^ti\s+ti-/, "") || "apps";

/** One request as a v2 row: its place (origin, time) around the same card as v1. */
function Entry(props: ApprovalEntryProps) {
  const t = useApprovalMessages();
  const locale = useLocale();
  const card = createMemo(() => approvalCard(approvalCardInput(props.item), locale(), READER_TIME_ZONE));
  const automation = () => props.item.requester.automation;
  const place: ApprovalPlace = {
    get locale() {
      return locale();
    },
    get origin() {
      return { text: approvalOrigin(props.item, t()), href: props.item.requester.href };
    },
    get automation() {
      const source = automation();
      return source ? { text: t().fromAutomation({ title: source.title }), href: source.href } : undefined;
    },
    get createdAt() {
      return props.item.createdAt;
    },
    frame: (frame) => <ApprovalFrameV2 frame={frame} place={place} />,
  };
  return (
    <ApprovalPlaceContext.Provider value={place}>
      <ApprovalEntry {...props} card={card()} />
    </ApprovalPlaceContext.Provider>
  );
}

/**
 * `Approvals` in a page built with `@k2b/ui/v2` (its layout has `ui: "v2"`), from `@k2b/cloud/approvals/v2`: the
 * content of the page's `Pane`. One `Section` per app (or one `List` for one app or one
 * resource), each request a row that keeps its place as a receipt once decided. The same state as the v1 list.
 */
export default function ApprovalsV2(props: ApprovalsProps) {
  const t = useApprovalMessages();
  const list = createApprovalList(props, (targets) =>
    confirm({
      title: t().rejectAllTitle,
      description: targets.some((item) => item.requester.kind === "code_version")
        ? t().rejectAllWithVersions
        : t().rejectAllBody({ count: targets.length }),
      confirm: t().rejectAll,
    }),
  );
  // k2b-ui gap: v2 has no virtualized list yet (lane MW builds it on VirtualFeed). The list grows only by "Show more"
  // pages a person asks for, so its rows stay bounded by what they loaded; switch to the virtual list once it lands.
  const rows = (entries: PendingApproval[]) => (
    <For each={entries}>
      {(item) => (
        <Entry
          item={list.withEdit(item)}
          editDraft={list.editDraft(item)}
          outcome={list.outcomes().get(item.id)}
          busy={list.busy().has(item.id)}
          failed={list.failed().get(item.id) ?? false}
          decide={(input) => void list.decide(item, input)}
          retry={() => list.retry(item)}
          reopen={() => list.reopen(item)}
        />
      )}
    </For>
  );
  return (
    // A list beside one resource stays out of the way until a request for it waits.
    <Show when={!props.link || list.items().length > 0}>
      <Show
        when={list.page()}
        fallback={
          <Show when={list.loadError()} fallback={<Loading rows={2} lines={3} />}>
            <Failed text={t().loadFailed} onRetry={() => void list.reload()} />
          </Show>
        }
      >
        <Show when={list.items().length > 0} fallback={<Empty icon="circle-check" text={`${t().emptyTitle} ${t().emptyBody}`} />}>
          {/* A single request needs no count: the row is the count. The bar depends on the shown requests, which stay
              in place when decided, so deciding never moves the list. */}
          <Show when={!props.link && list.items().length > 1}>
            <Bar
              start={<Text>{t().open({ count: list.openCount() })}</Text>}
              end={
                <Show when={list.open().length > 1}>
                  <Button variant="text" icon="x" onClick={() => void list.rejectAll()}>
                    {t().rejectAll}
                  </Button>
                </Show>
              }
            />
          </Show>
          <Show
            when={props.app || props.link}
            fallback={
              <For each={list.groups()}>
                {(group) => (
                  <Section icon={iconName(group[0]?.app.icon)} title={group[0]?.app.name ?? ""} count={group.length}>
                    {rows(group)}
                  </Section>
                )}
              </For>
            }
          >
            <List label={t().title}>{rows(list.items())}</List>
          </Show>
          <Show when={list.page()?.nextCursor}>
            {/* A failed next page keeps the rows already shown; it fails in the place of the page that did not come. */}
            <Show
              when={list.moreError()}
              fallback={
                <Bar
                  end={
                    <Button variant="text" icon="chevron-down" busy={list.loadingMore()} onClick={() => void list.loadMore()}>
                      {t().showMore}
                    </Button>
                  }
                />
              }
            >
              <Failed text={t().loadMoreFailed} onRetry={() => void list.loadMore()} />
            </Show>
          </Show>
        </Show>
        <Show when={(list.page()?.elsewhere ?? 0) > 0}>
          <List label={t().allApprovals}>
            <Row
              icon="arrow-up-right"
              lines={[t().elsewhere({ count: list.page()?.elsewhere ?? 0 })]}
              meta={t().allApprovals}
              href={APPROVALS_PAGE_PATH}
            />
          </List>
        </Show>
      </Show>
    </Show>
  );
}
