import { useLocale } from "@k2b/ui";
import { Bar, Button, Failed, FilterBar, Notice, Pane, StatusRow, Table, Text, Workspace } from "@k2b/ui/v2";
import { createMemo, createSignal, Show } from "solid-js";
import AccountsNav from "../AccountsNav";
import { BATCH_PATH, kindHref } from "../activity/kind";
import { useActivityMessages } from "../activity/messages";
import { usePageSwap } from "../lib/page-swap";
import { useListMessages } from "../list-messages";
import { useAccountsMessages } from "../messages";
import { type BatchStatus, batchChip } from "./chips";
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
  const activity = useActivityMessages();
  const [state, setState] = createSignal<BatchesState>(props.state);
  const [ignored, setIgnored] = createSignal(props.ignored);
  const [refreshing, setRefreshing] = createSignal(false);
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
    setRefreshing(true);
    const params = new URLSearchParams(location.search);
    if (params.has("page")) {
      params.delete("page");
      history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`);
    }
    void showChanges();
  };
  const newHref = () => href({ page: 1, creating: true });

  return (
    <Workspace
      sidebar={<AccountsNav active="notifications" pendingRequests={props.pendingRequests} />}
      detail={props.creating ? 400 : undefined}
      head={
        <Bar
          start={<Text type="body">{activity().activity}</Text>}
          end={
            <Button variant="primary" icon="plus" href={newHref()}>
              {t().newNotification}
            </Button>
          }
        />
      }
      primary={{ label: t().newNotification, icon: "plus", href: newHref() }}
    >
      <Pane.Split>
        <Pane
          label={t().notifications}
          scrollKey="accounts-notifications"
          status={
            <>
              <FilterBar
                query={query()}
                state={state()}
                onChange={change}
                icons={{ kind: "activity", status: "circle-check" }}
                results={words().batches({ count: number(props.total) })}
              />
              <StatusRow lead={props.rows ? words().batches({ count: number(props.total) }) : words().loadFailed} loading={refreshing()} />
            </>
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
                  lines: [row.subject, `${row.recipients} · ${row.created}`],
                  marks: batchChip(row.status, batchStatusLabel(t(), row.status)),
                })}
                columns={[
                  { title: t().subject, width: { min: 200, default: 300 }, cell: (row) => ({ lines: [row.subject, row.note] }) },
                  {
                    title: t().status,
                    width: { min: 140, default: 150 },
                    cell: (row) => batchChip(row.status, batchStatusLabel(t(), row.status)),
                  },
                  { title: t().recipients, width: { min: 140, default: 170 }, cell: (row) => row.recipients, drop: true },
                  { title: t().sent, width: { min: 80, default: 90 }, align: "end", cell: (row) => row.sent, drop: true },
                  {
                    title: t().errors,
                    width: { min: 80, default: 90 },
                    align: "end",
                    cell: (row) => (row.hasErrors ? <Text tone="bad">{row.errors}</Text> : row.errors),
                    drop: true,
                  },
                  { title: t().created, cell: (row) => row.created, drop: true },
                ]}
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
