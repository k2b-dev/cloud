import { Approvals } from "@k2b/cloud/approvals/ui";
import type { ApprovalPage } from "@k2b/cloud/contracts/approvals";
import { swapPage } from "@k2b/ssr/nav";
import { Bar, Button, Canvas, Chip, Empty, FilterBar, List, Pane, Row, StatusRow, Text } from "@k2b/ui/v2";
import type { ListQueryState } from "@k2b/ui/v2/list-query";
import { createMemo, createSignal, For, Show } from "solid-js";
import AccountWorkspace, { useAccountMessages } from "./AccountWorkspace";
import type { AccountUserView } from "./account-view";
import { type ActivityKind, activityPageHref, activityQueryFor, kindOfState } from "./activity-query";

/** One entry of the deliveries or the sign-in activity, as the server formatted it: words, not codes. */
export type ActivityRow = {
  id: string;
  time: string;
  title: string;
  href: string | null;
  /** Where it came from: the app and kind of a notification, the context of a sign-in. */
  source: string;
  state: { label: string; tone?: "ok" | "warn" | "bad" };
  /** Why it failed, in words; nothing for an entry that went through or still waits. */
  detail: string | null;
  /** What the entry is about: the app of a notification, the kind of thing of an account event. */
  mark: { icon: string; color?: string };
};

export type ActivityScreenProps = {
  user: AccountUserView;
  /** The address's filter, in the fields of its kind. */
  state: ListQueryState;
  /** What the kind of the address shows: the open approvals, or the entries of a page. */
  content:
    | { kind: "open"; app?: string; approvals: ApprovalPage }
    | {
        kind: Exclude<ActivityKind, "open">;
        rows: ActivityRow[];
        total: number;
        page: number;
        pages: number;
        /** What went wrong in the whole range, counted by the server: failed deliveries, refused and failed attempts. */
        problems: { failed: number; denied: number };
      };
};

/**
 * `/me/activity` on v2: one list of what happened on the account and what waits for the person. The kind is the first
 * filter: open approvals by default, the deliveries of notifications, or the sign-in activity.
 */
export default function ActivityScreen(props: ActivityScreenProps) {
  const t = useAccountMessages();
  const [state, setState] = createSignal(props.state);
  // The bar offers only the filters of the kind it shows.
  const query = createMemo(() => activityQueryFor(t(), kindOfState(state())));
  const entries = () => (props.content.kind === "open" ? null : props.content);
  const open = () => (props.content.kind === "open" ? props.content : null);
  // The count is a fact of the bar; the lead says what needs the person.
  const count = () => {
    const content = props.content;
    return content.kind === "open"
      ? t().openApprovalsCount({ count: content.approvals.items.length })
      : content.kind === "deliveries"
        ? t().deliveryCount({ count: content.total })
        : t().activityCount({ count: content.total });
  };
  // A state is shown where it is an exception; what went as expected carries no chip.
  const exceptional = (row: ActivityRow) => row.state.tone !== "ok";
  // The status row stands only for what needs the person: open approvals, or entries that went wrong anywhere in range.
  const needsYou = () => {
    const content = props.content;
    // the approval list names its own open count, so the statement would say it twice
    return content.kind !== "open" && content.problems.failed + content.problems.denied > 0;
  };
  const lead = () => {
    const content = props.content;
    if (content.kind === "open") return "";
    if (content.kind === "deliveries") return t().notDelivered({ count: content.problems.failed });
    // a refusal and a failure are different things: each is said with its own word
    return [
      ...(content.problems.denied > 0 ? [t().deniedAttempts({ count: content.problems.denied })] : []),
      ...(content.problems.failed > 0 ? [t().failedAttempts({ count: content.problems.failed })] : []),
    ].join(" · ");
  };
  const chip = (row: ActivityRow) =>
    !exceptional(row) ? undefined : row.state.tone ? (
      <Chip status={row.state.tone}>{row.state.label}</Chip>
    ) : (
      <Chip>{row.state.label}</Chip>
    );
  return (
    <AccountWorkspace user={props.user} place="activity">
      <Pane
        label={t().activity}
        scrollKey="account-activity"
        // the filter row and the statement are the toolbar rows of the column; #4290 joins them to the head as one block
        status={
          <>
            <FilterBar
              query={query()}
              state={state()}
              results={count()}
              icons={{ kind: "list", status: "send", activityDays: "calendar" }}
              onChange={(next) => {
                // a new kind keeps only the filters it has
                const own = activityQueryFor(t(), kindOfState(next));
                setState(own.parse(own.serialize(next)).state);
                // The bar wrote the address; the server reads the kind and its filter from it and renders the entries.
                void swapPage(activityPageHref(t(), next, 1), { replace: true, scroll: "preserve" });
              }}
            />

            {/* with nothing to show the empty state speaks alone, so the lead never says it a second time */}
            <Show when={needsYou()}>
              <StatusRow lead={lead()} facts={[{ value: count() }]} />
            </Show>
          </>
        }
      >
        <Show when={open()}>
          {(approvals) => (
            // k2b-ui gap: the platform's approval list (`@k2b/cloud/approvals/ui`, shared by several apps) is still v1; it
            // stands in a Canvas until a v2 list exists (platform lane PS).
            <Canvas label={t().openApprovals}>
              <Approvals app={approvals().app} initial={approvals().approvals} />
            </Canvas>
          )}
        </Show>
        <Show when={entries()}>
          {(list) => (
            <>
              <Show when={list().kind === "deliveries"}>
                <Text muted type="meta">
                  {t().deliveryMetadataOnly}
                </Text>
              </Show>
              {/* rows, not a table: each entry leads with its mark, nothing is cut at any width, and only an exception
                  carries a chip and its reason */}
              <Show
                when={list().rows.length > 0}
                fallback={
                  <Empty icon="clipboard-list" text={list().kind === "deliveries" ? t().noNotificationDeliveries : t().noActivityInRange} />
                }
              >
                <List label={t().activity}>
                  <For each={list().rows}>
                    {(row) => (
                      <Row
                        mark={row.mark}
                        // a failure says why first in its second line, then where it came from; the line wraps, so the
                        // reason is never cut
                        lines={row.detail ? [row.title, `${row.detail} · ${row.source}`] : [row.title, row.source]}
                        time={row.time}
                        marks={chip(row)}
                        href={row.href ?? undefined}
                      />
                    )}
                  </For>
                </List>
              </Show>
              <Show when={list().pages > 1}>
                <Bar
                  start={<Text type="meta">{t().pageOf({ page: list().page, pages: list().pages })}</Text>}
                  end={
                    <>
                      <Button icon="chevron-left" href={activityPageHref(t(), state(), list().page - 1)} disabled={list().page <= 1}>
                        {t().previous}
                      </Button>
                      <Button href={activityPageHref(t(), state(), list().page + 1)} disabled={list().page >= list().pages} forward>
                        {t().next}
                      </Button>
                    </>
                  }
                />
              </Show>
            </>
          )}
        </Show>
      </Pane>
    </AccountWorkspace>
  );
}
