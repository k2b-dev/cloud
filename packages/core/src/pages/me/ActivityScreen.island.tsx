import { Approvals } from "@k2b/cloud/approvals/ui";
import type { ApprovalPage } from "@k2b/cloud/contracts/approvals";
import { swapPage } from "@k2b/ssr/nav";
import { Bar, Button, Canvas, Chip, FilterBar, Pane, StatusRow, Table, Text } from "@k2b/ui/v2";
import { createMemo, createSignal, Show } from "solid-js";
import AccountWorkspace, { useAccountMessages } from "./AccountWorkspace";
import type { AccountUserView } from "./account-view";
import { type ActivityKind, type ActivityState, activityPageHref, activityQuery } from "./activity-query";

/** One entry of the deliveries or the sign-in activity, as the server formatted it: words, not codes. */
export type ActivityRow = {
  id: string;
  time: string;
  title: string;
  href: string | null;
  /** Where it came from: the app and kind of a notification, the context of a sign-in. */
  source: string;
  state: { label: string; tone?: "ok" | "warn" | "bad" };
  /** A failure's reason, or where a delivery went. */
  detail: string | null;
  /** What the entry is about: the app of a notification, the kind of thing of an account event. */
  mark: { icon: string; color?: string };
};

export type ActivityScreenProps = {
  user: AccountUserView;
  state: ActivityState;
  /** What the kind of the address shows: the open approvals, or the entries of a page. */
  content:
    | { kind: "open"; app?: string; approvals: ApprovalPage }
    | { kind: Exclude<ActivityKind, "open">; rows: ActivityRow[]; total: number; page: number; pages: number };
};

/**
 * `/me/activity` on v2: one list of what happened on the account and what waits for the person. The kind is the first
 * filter: open approvals by default, the deliveries of notifications, or the sign-in activity.
 */
export default function ActivityScreen(props: ActivityScreenProps) {
  const t = useAccountMessages();
  const query = createMemo(() => activityQuery(t()));
  const [state, setState] = createSignal(props.state);
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
  const problems = () => entries()?.rows.filter((row) => row.state.tone === "bad" || row.state.tone === "warn").length ?? 0;
  // The status row stands only for what needs the person: open approvals, or entries that went wrong.
  const needsYou = () => (props.content.kind === "open" ? props.content.approvals.items.length > 0 : problems() > 0);
  const lead = () => {
    const content = props.content;
    if (content.kind === "open") return t().waitingForYou({ count: content.approvals.items.length });
    return content.kind === "deliveries" ? t().notDelivered({ count: problems() }) : t().deniedAttempts({ count: problems() });
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
        status={
          <>
            <FilterBar
              query={query()}
              state={state()}
              results={count()}
              icons={{ kind: "list", status: "send", activityDays: "calendar" }}
              onChange={(next) => {
                setState(next);
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
              <Table
                label={t().activity}
                rows={list().rows}
                rowKey={(row) => row.id}
                empty={{
                  icon: "clipboard-list",
                  text: list().kind === "deliveries" ? t().noNotificationDeliveries : t().noActivityInRange,
                }}
                // k2b-ui gap: a table cell cannot lead with the thing's mark yet (`Column mark`, #4223); the phone rows do.
                phone={(row) => ({ mark: row.mark, lines: [row.title, row.source], time: row.time, marks: chip(row) })}
                columns={[
                  { title: t().time, width: { min: 160, default: 170 }, cell: (row) => row.time },
                  {
                    title: list().kind === "deliveries" ? t().notification : t().activity,
                    width: { min: 180, default: 250 },
                    cell: (row) => (row.href ? <Text href={row.href}>{row.title}</Text> : row.title),
                  },
                  {
                    title: list().kind === "deliveries" ? t().source : t().context,
                    width: { min: 120, default: 170 },
                    cell: (row) => row.source,
                    drop: true,
                  },
                  { title: t().status, width: { min: 110, default: 130 }, cell: chip },
                  // why a delivery failed or where it went; on the phone the row keeps its state
                  ...(list().kind === "deliveries"
                    ? [{ title: t().details, wrap: true, cell: (row: ActivityRow) => row.detail ?? "", drop: true }]
                    : []),
                ]}
              />
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
