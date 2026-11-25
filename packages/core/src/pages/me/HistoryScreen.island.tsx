import { swapPage } from "@k2b/ssr/nav";
import { Bar, Button, Chip, FilterBar, Pane, StatusRow, Table, Text } from "@k2b/ui/v2";
import { createMemo, createSignal, Show } from "solid-js";
import AccountWorkspace, { useAccountMessages } from "./AccountWorkspace";
import type { AccountUserView } from "./account-view";
import { type HistoryState, historyHref, historyQuery } from "./history-query";
import NotificationTabs from "./NotificationTabs";

/** One delivery as the server formatted it: words, not codes, and the time as text. */
export type HistoryRow = {
  id: string;
  time: string;
  title: string;
  href: string | null;
  source: string;
  channel: string;
  destination: string;
  status: { label: string; tone?: "ok" | "warn" | "bad" };
  error: string | null;
};

/** `/me/notifications/history` on v2: the deliveries of the person's notifications, metadata only, newest first. */
export default function HistoryScreen(props: {
  user: AccountUserView;
  appTab: boolean;
  state: HistoryState;
  rows: HistoryRow[];
  total: number;
  page: number;
  pages: number;
}) {
  const t = useAccountMessages();
  const query = createMemo(() => historyQuery(t()));
  const [state, setState] = createSignal(props.state);
  const count = () => t().deliveryCount({ count: props.total });
  const chip = (row: HistoryRow) =>
    row.status.tone ? <Chip status={row.status.tone}>{row.status.label}</Chip> : <Chip>{row.status.label}</Chip>;
  return (
    <AccountWorkspace user={props.user} active="notifications" appTab={props.appTab}>
      <Pane
        label={t().deliveryHistory}
        head={<NotificationTabs active="history" />}
        scrollKey="notification-history"
        status={
          <>
            <FilterBar
              query={query()}
              state={state()}
              results={count()}
              onChange={(next) => {
                setState(next);
                // A new filter starts at the first page; the server reads both from the address.
                void swapPage(historyHref(t(), next, 1), { replace: true, scroll: "preserve" });
              }}
            />
            <StatusRow lead={count()} />
          </>
        }
      >
        <Text muted>{t().deliveryMetadataOnly}</Text>
        <Table
          label={t().recentDeliveries}
          rows={props.rows}
          rowKey={(row) => row.id}
          empty={{ icon: "bell-off", text: t().noNotificationDeliveries }}
          phone={(row) => ({ lines: [row.title, `${row.source} · ${row.channel}`], time: row.time, marks: chip(row) })}
          columns={[
            { title: t().time, width: { min: 140, default: 160 }, cell: (row) => row.time },
            {
              title: t().notification,
              width: { min: 200, default: 260 },
              wrap: true,
              cell: (row) => (row.href ? <Text href={row.href}>{row.title}</Text> : row.title),
            },
            { title: t().source, width: { min: 140, default: 180 }, cell: (row) => row.source, drop: true },
            {
              title: t().channel,
              width: { min: 140, default: 180 },
              cell: (row) => ({ lines: [row.channel, row.destination] }),
              drop: true,
            },
            { title: t().status, cell: (row) => (row.error ? { lines: [row.status.label, row.error] } : chip(row)) },
          ]}
        />
        <Show when={props.pages > 1}>
          <Bar
            start={<Text type="meta">{t().pageOf({ page: props.page, pages: props.pages })}</Text>}
            end={
              <>
                <Button icon="chevron-left" href={historyHref(t(), state(), props.page - 1)} disabled={props.page <= 1}>
                  {t().previous}
                </Button>
                <Button href={historyHref(t(), state(), props.page + 1)} disabled={props.page >= props.pages} forward>
                  {t().next}
                </Button>
              </>
            }
          />
        </Show>
      </Pane>
    </AccountWorkspace>
  );
}
