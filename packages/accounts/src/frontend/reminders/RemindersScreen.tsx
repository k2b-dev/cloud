import { useLocale } from "@k2b/ui";
import {
  Avatar,
  Bar,
  Button,
  Chip,
  FilterBar,
  Inline,
  Input,
  ListOrder,
  Notice,
  Pane,
  StatusRow,
  Table,
  Text,
  Workspace,
} from "@k2b/ui/v2";
import { createMemo, createSignal, Show } from "solid-js";
import { usePageSwap } from "@/frontend/lib/page-swap";
import AccountsNav from "../AccountsNav";
import { kindHref } from "../activity/kind";
import { useActivityMessages } from "../activity/messages";
import { useListMessages } from "../list-messages";
import { useAccountsMessages } from "../messages";
import { useReminderMessages } from "./messages";
import { type RemindersState, remindersHref, remindersQuery } from "./query";

export type ReminderRow = {
  id: string;
  /** The person's name, or null when the account was deleted since. */
  name: string | null;
  image?: string;
  status: string;
  /** The expiry the reminder warned of, formatted by the server, and how many days before it the reminder went out. */
  target: string;
  days: number;
  attempts: number;
  lastAttempt: string | null;
  error: string | null;
};

export type RemindersScreenProps = {
  state: RemindersState;
  page: number;
  pages: number;
  total: number;
  rows: ReminderRow[];
  /** Parameters of the address that did not apply, already worded. */
  ignored: string | null;
  pendingRequests: number;
};

const statusTone = (status: string) => (status === "sent" ? "ok" : status === "error" ? "bad" : "warn");

/**
 * The reminder history on v2, the kind "Erinnerungen" of the activity page: the status as a filter statement, the search in the head, one row per reminder with
 * its last error. Every change shows the list again from the server.
 */
export default function RemindersScreen(props: RemindersScreenProps) {
  const locale = useLocale();
  const t = useAccountsMessages();
  const r = useReminderMessages();
  const words = useListMessages();
  const activity = useActivityMessages();
  const { showChanges, openPage } = usePageSwap();
  const query = createMemo(() => remindersQuery(locale()));
  const [state, setState] = createSignal<RemindersState>(props.state);
  const [ignored, setIgnored] = createSignal(props.ignored);
  const [refreshing, setRefreshing] = createSignal(false);
  const changed = () => query().serialize(state()).toString() !== query().serialize(query().reset()).toString();
  const name = (row: ReminderRow) => row.name ?? `(${t().deletedUser})`;
  const statusLabel = (status: string) => (status === "pending" ? t().pending : status === "sent" ? t().sent : t().error);
  const chip = (row: ReminderRow) => <Chip status={statusTone(row.status)}>{statusLabel(row.status)}</Chip>;

  /** The bar wrote the address; a new filter starts at page 1, and the server shows the list for it. */
  const change = (next: RemindersState) => {
    // another kind is another list: it opens with its own filters, none of these
    if (next.filters.kind !== "reminders") return void openPage(kindHref(next.filters.kind), { replace: true });
    setState(next);
    setRefreshing(true);
    const params = new URLSearchParams(location.search);
    if (params.has("page")) {
      params.delete("page");
      history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`);
    }
    void showChanges();
  };
  const search = (text: string) => {
    const next = query().set(state(), "q", text.trim());
    if (next) {
      setRefreshing(true);
      void openPage(remindersHref(query(), next));
    }
  };

  return (
    <Workspace
      sidebar={<AccountsNav active="reminders" pendingRequests={props.pendingRequests} />}
      head={
        <Bar
          start={<Text type="body">{activity().activity}</Text>}
          end={
            <Input
              type="search"
              icon="search"
              label={r().searchLabel}
              placeholder={r().searchLabel}
              value={state().search ?? ""}
              onKeyDown={(event) => {
                if (event.isComposing) return;
                const input = event.currentTarget as HTMLInputElement;
                if (event.key === "Enter") search(input.value);
                if (event.key === "Escape" && input.value) {
                  input.value = "";
                  search("");
                }
              }}
            />
          }
        />
      }
    >
      <Pane
        label={t().reminderHistory}
        scrollKey="accounts-reminders"
        status={
          <>
            <FilterBar
              query={query()}
              state={state()}
              onChange={change}
              icons={{ kind: "activity", status: "circle-dot" }}
              results={t().entryCount({ count: props.total })}
            />
            <StatusRow
              lead={t().entryCount({ count: props.total })}
              loading={refreshing()}
              filters={<ListOrder query={query()} state={state()} onChange={change} />}
            />
          </>
        }
      >
        <Show when={ignored()}>
          {(text) => (
            <Notice tone="warn" title={words().ignoredParts} actions={[{ label: words().hide, onClick: () => setIgnored(null) }]}>
              {text()}
            </Notice>
          )}
        </Show>
        {/* k2b-ui gap: virtualized list (lane MW). Until it lands the server pages the list (at most one page of rows in the DOM). */}
        <Table
          label={t().reminderHistory}
          rows={props.rows}
          rowKey={(row) => row.id}
          sticky
          empty={
            changed() || state().search
              ? {
                  icon: "filter-off",
                  text: r().noMatches,
                  action: { label: words().resetFilters, icon: "filter-off", href: kindHref("reminders") },
                }
              : { icon: "bell", text: t().noReminders }
          }
          phone={(row) => ({
            lines: [name(row), row.error || r().daysBefore({ when: row.target, count: row.days })],
            avatar: { name: name(row), image: row.image },
            marks: chip(row),
          })}
          columns={[
            {
              title: t().user,
              width: { min: 180, default: 240 },
              cell: (row) => (
                <Inline>
                  <Avatar name={name(row)} image={row.image} decorative />
                  <Text weight="strong">{name(row)}</Text>
                </Inline>
              ),
            },
            {
              title: t().status,
              width: { min: 140, default: 240 },
              cell: (row) => (row.error ? { lines: [chip(row), row.error] } : chip(row)),
            },
            {
              title: t().targetExpiry,
              width: { min: 180, default: 220 },
              cell: (row) => r().daysBefore({ when: row.target, count: row.days }),
              drop: true,
            },
            { title: t().attempts, width: { min: 80, default: 100 }, align: "end", cell: (row) => row.attempts, drop: true },
            { title: t().lastAttempt, width: { min: 130, default: 150 }, cell: (row) => row.lastAttempt ?? "–", drop: true },
            { title: t().kind, cell: () => t().accountExpiry, drop: true },
          ]}
        />
        <Show when={props.pages > 1}>
          <Bar
            start={<Text type="meta">{words().pageOf({ page: props.page, pages: props.pages })}</Text>}
            end={
              <>
                <Button icon="chevron-left" href={remindersHref(query(), state(), props.page - 1)} disabled={props.page <= 1}>
                  {words().previous}
                </Button>
                <Button href={remindersHref(query(), state(), props.page + 1)} disabled={props.page >= props.pages} forward>
                  {words().next}
                </Button>
              </>
            }
          />
        </Show>
      </Pane>
    </Workspace>
  );
}
