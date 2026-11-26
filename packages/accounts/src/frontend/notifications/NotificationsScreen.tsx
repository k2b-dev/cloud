import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Chip,
  type Column,
  Failed,
  FilterBar,
  Inline,
  Mark,
  Notice,
  Pane,
  Progress,
  Table,
  Text,
  Workspace,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, Show } from "solid-js";
import AccountsNav from "../AccountsNav";
import { BATCH_PATH, kindHref } from "../activity/kind";
import { usePageSwap } from "../lib/page-swap";
import { useListMessages } from "../list-messages";
import { useAccountsMessages } from "../messages";
import { BATCH_MARK, type BatchStatus, batchChip } from "./chips";
import { useNotificationMessages } from "./messages";
import NewBatchPane from "./NewBatchPane";
import { type BatchesState, batchesHref, batchesQuery, batchStatusLabel } from "./query";

/** One batch as the list shows it; numbers and dates are worded on the server, so both pictures agree. */
export type BatchRow = {
  id: string;
  subject: string;
  /** The last error, or what kind of batch it is. */
  note: string;
  status: BatchStatus;
  recipients: string;
  sent: string;
  /** Delivered so far and deliverable in all, for the delivery bar. */
  sentCount: number;
  deliverableCount: number;
  deliverable: string;
  errors: string;
  hasErrors: boolean;
  created: string;
};

export type NotificationsScreenProps = {
  state: BatchesState;
  page: number;
  pages: number;
  total: number;
  /** The batches of this page; null when they could not be read. */
  rows: BatchRow[] | null;
  /** Whether the form for a new batch stands beside the list (`?new=1`). */
  creating: boolean;
  ignored: string | null;
  pendingRequests: number;
};

/**
 * The notification batches on v2, the kind "Benachrichtigungen" of the activity page: the status as a statement, one row per batch that opens it, and "New notification"
 * as the one primary, which opens the form beside the list. The address holds the filter, the page and the open form.
 */
export default function NotificationsScreen(props: NotificationsScreenProps) {
  const locale = useLocale();
  const t = useAccountsMessages();
  const words = useNotificationMessages();
  const list = useListMessages();
  const { showChanges, openPage } = usePageSwap();
  const query = createMemo(() => batchesQuery(locale()));
  const [state, setState] = createSignal<BatchesState>(props.state);
  const [ignored, setIgnored] = createSignal(props.ignored);
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const changed = () => state().filters.status !== undefined;
  const listHref = kindHref("notifications");
  const href = (extra: { page?: number; creating?: boolean } = {}) =>
    batchesHref(query(), state(), { page: extra.page ?? props.page, creating: extra.creating ?? props.creating });

  /** The bar wrote the address; a new filter starts at page 1, and the server shows the list for it. */
  const change = (next: BatchesState) => {
    // another kind is another list: it opens with its own filters, none of these
    if (next.filters.kind !== "notifications") return void openPage(kindHref(next.filters.kind), { replace: true });
    setState(next);
    const params = new URLSearchParams(location.search);
    if (params.has("page")) {
      params.delete("page");
      history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`);
    }
    void showChanges();
  };
  const newHref = () => href({ page: 1, creating: true });
  /**
   * What needs a look: batches that run, and batches with errors, each a chip that filters to them. The numbers count
   * when every batch stands on this page; with more pages the chips filter without a number.
   */
  const attention = () => {
    const rows = props.pages === 1 ? (props.rows ?? []) : null;
    const count = (statuses: readonly BatchStatus[]) => rows?.filter((row) => statuses.includes(row.status)).length;
    const base = query().reset();
    const chip = (value: BatchStatus, status: "warn" | "bad", statuses: readonly BatchStatus[], label: string) => {
      const n = count(statuses);
      const next = query().set({ ...base, filters: { ...base.filters, kind: "notifications" } }, "status", value);
      if (n === 0 || !next) return [];
      return [{ value, status, label: n === undefined ? label : `${number(n)} ${label}`, href: batchesHref(query(), next) }];
    };
    return [
      ...chip("running", "warn", ["running", "ready"], words().runningNow),
      ...chip("completed_with_errors", "bad", ["completed_with_errors", "failed"], words().withErrorsNow),
    ];
  };

  return (
    <Workspace
      sidebar={<AccountsNav active="activity" pendingRequests={props.pendingRequests} />}
      detail={props.creating ? 400 : undefined}
      head={
        <Bar
          // k2b-ui gap: head rows (lane DP). The statement and its chips stand in the head, the filters below: two rows.
          start={
            <Inline>
              <Text weight="strong">{props.rows ? words().batches({ count: number(props.total) }) : words().loadFailed}</Text>
              <For each={attention()}>
                {(chip) => (
                  <Chip status={chip.status} href={chip.href} pressed={state().filters.status === chip.value}>
                    {chip.label}
                  </Chip>
                )}
              </For>
            </Inline>
          }
          // while the form is open, it stands for the deed; on the phone it is the page and keeps its own buttons
          end={
            props.creating ? undefined : (
              <Button variant="primary" icon="plus" href={newHref()}>
                {t().newNotification}
              </Button>
            )
          }
        />
      }
      primary={props.creating ? undefined : { label: t().newNotification, icon: "plus", href: newHref() }}
    >
      <Pane.Split>
        <Pane
          label={t().notifications}
          scrollKey="accounts-notifications"
          status={
            <FilterBar
              query={query()}
              state={state()}
              onChange={change}
              icons={{ kind: "activity", status: "circle-check" }}
              results={words().batches({ count: number(props.total) })}
            />
          }
        >
          <Show when={ignored()}>
            {(text) => (
              <Notice tone="warn" title={list().ignoredParts} actions={[{ label: list().hide, onClick: () => setIgnored(null) }]}>
                {text()}
              </Notice>
            )}
          </Show>
          {/* k2b-ui gap: virtualized list (lane MW). Until it lands the server pages the list (at most one page of rows in the DOM). */}
          <Show when={props.rows} fallback={<Failed text={words().loadFailed} onRetry={() => void showChanges()} />}>
            {(rows) => (
              <Table
                label={t().notifications}
                rows={rows()}
                rowKey={(row) => row.id}
                sticky
                open={(row) => ({ href: `${BATCH_PATH}/${row.id}` })}
                empty={
                  changed()
                    ? {
                        icon: "filter-off",
                        text: words().noMatches,
                        action: { label: list().resetFilters, icon: "filter-off", href: listHref },
                      }
                    : {
                        icon: "mail-share",
                        text: t().noNotificationBatches,
                        action: { label: t().newNotification, icon: "plus", href: newHref() },
                      }
                }
                phone={(row) => ({
                  mark: BATCH_MARK,
                  lines: [row.subject, `${words().sentOf({ sent: row.sent, total: row.deliverable })} · ${row.created}`],
                  marks: batchChip(row.status, batchStatusLabel(t(), row.status)),
                })}
                columns={(
                  [
                    {
                      title: t().subject,
                      width: { min: 220, default: 320 },
                      cell: (row) => ({
                        lines: [
                          <Inline>
                            <Mark {...BATCH_MARK} />
                            <Text>{row.subject}</Text>
                          </Inline>,
                          row.note,
                        ],
                      }),
                    },
                    {
                      title: t().status,
                      width: { min: 140, default: 150 },
                      cell: (row) => batchChip(row.status, batchStatusLabel(t(), row.status)),
                    },
                    {
                      title: t().sent,
                      width: { min: 170, default: 200 },
                      // how far the delivery got: sent of the deliverable recipients, as a bar
                      cell: (row) => (
                        <Progress
                          value={row.sentCount}
                          of={row.deliverableCount}
                          label={words().sentOf({ sent: row.sent, total: row.deliverable })}
                        />
                      ),
                      drop: true,
                    },
                    {
                      title: t().errors,
                      width: { min: 80, default: 90 },
                      align: "end",
                      cell: (row) => (row.hasErrors ? <Text tone="bad">{row.errors}</Text> : row.errors),
                      drop: true,
                    },
                    { title: t().created, cell: (row) => row.created, drop: true },
                  ] satisfies Column<BatchRow>[]
                )
                  // beside the open form the list keeps what tells the batches apart; the rest is a press away
                  .filter((_, index) => !props.creating || index < 2)}
              />
            )}
          </Show>
          <Show when={props.pages > 1}>
            <Bar
              start={<Text type="meta">{list().pageOf({ page: props.page, pages: props.pages })}</Text>}
              end={
                <>
                  <Button icon="chevron-left" href={href({ page: props.page - 1 })} disabled={props.page <= 1}>
                    {list().previous}
                  </Button>
                  <Button href={href({ page: props.page + 1 })} disabled={props.page >= props.pages} forward>
                    {list().next}
                  </Button>
                </>
              }
            />
          </Show>
        </Pane>
        <Show when={props.creating}>
          <NewBatchPane closeHref={href({ creating: false })} />
        </Show>
      </Pane.Split>
    </Workspace>
  );
}
