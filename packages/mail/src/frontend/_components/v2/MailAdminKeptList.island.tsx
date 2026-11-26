import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { swapPage } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import {
  Avatar,
  Band,
  Bar,
  Button,
  Chip,
  Failed,
  Inline,
  Input,
  Mark,
  type NavProps,
  Pane,
  Spark,
  StatusRow,
  Table,
  Text,
  useToast,
} from "@k2b/ui/v2";
import { createMemo, createSignal, Show } from "solid-js";
import { keptListHref } from "../../admin-sections";
import { mailKeptAdminMessages } from "../../kept-admin-messages";
import { downloadKeptConversations } from "../kept-admin-download";
import { keptMark } from "./mail-admin-kept-mark";

/** One kept conversation as the list shows it; the page words and formats it, so the first render matches the server. */
export type MailAdminKeptRow = {
  mailboxId: string;
  conversationId: string;
  href: string;
  mailboxName: string;
  mailboxDeleted: boolean;
  subject: string;
  /** The sender's name, else the address, else "Unknown sender". */
  sender: string;
  /** The newest message: a short date for the cell, the full time for its tooltip. */
  date: { text: string; title: string; iso: string } | null;
  keptBy: string;
  keptSince: { text: string; title: string; iso: string };
};

export type MailAdminKeptListProps = {
  /** The admin bar, as the page built it with `adminNavigation(c, mailAdminSections(…))`. */
  nav: NavProps;
  rows: MailAdminKeptRow[];
  /** All kept conversations that match; `null` when the list could not be loaded. */
  total: number | null;
  /** Conversations kept per day over the last 30 days, oldest first (`countKeptPerDay`); `null` when it could not load. */
  perDay: number[] | null;
  /** Why the list could not be loaded, worded for the page. */
  failure: string | null;
  query: string;
  cursor: string | null;
  nextCursor: string | null;
};

const rowKey = (row: MailAdminKeptRow) => `${row.mailboxId}/${row.conversationId}`;

/**
 * Cloud administration › Mail › Kept on v2, after the filtered-table recipe: the search in the head, how many are kept
 * as the status row, one row of the same shape per kept conversation (its mark, subject, mailbox, sender, who kept it
 * and since when at the end), and a selection that downloads as one JSON file. The server searches and pages; a
 * search or a page is an address.
 */
export default function MailAdminKeptList(props: MailAdminKeptListProps) {
  const locale = useLocale();
  const t = createMemo(() => mailKeptAdminMessages.resolve([locale()]).t);
  const toast = useToast();
  const [selected, setSelected] = createSignal<readonly string[]>([]);
  const chosen = () => props.rows.filter((row) => selected().includes(rowKey(row)));
  const download = mutation.create<void, void>({
    mutation: (_, { abortSignal }) => downloadKeptConversations(chosen(), t().downloadFailed, abortSignal),
    onSuccess: () => toast(t().downloadStarted, { status: "ok" }),
    onError: (error) => toast(error.message, { status: "bad", retry: () => void download.mutate() }),
  });
  const lead = () => {
    if (props.total === null) return t().title;
    // the hero's statement until DP's band: how many are kept, or how many the search shows
    return props.query
      ? t().filteredCount({ count: props.rows.length, total: props.total })
      : t().keptTotal({ count: props.total, shown: number(props.total) });
  };
  // only what is not fine speaks up: conversations whose mailbox is gone live on as Cloud's kept copy alone
  const orphaned = () => props.rows.filter((row) => row.mailboxDeleted);
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const search = (text: string) => void swapPage(keptListHref({ q: text.trim() }));

  return (
    <AdminWorkspace
      nav={props.nav}
      head={
        <Bar
          end={
            <Input
              type="search"
              icon="search"
              label={t().searchLabel}
              placeholder={t().searchPlaceholder}
              value={props.query}
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
        label={t().title}
        scrollKey="mail-admin-kept"
        status={
          <StatusRow
            lead={lead()}
            // the real trend and two facts beside the hero; one box selects all (the table's head), and a selection
            // turns this row into its bar
            facts={
              props.query || props.cursor
                ? undefined
                : [
                    ...(props.perDay ? [{ value: number(props.perDay.reduce((sum, day) => sum + day, 0)), after: t().newIn30Days }] : []),
                    ...(props.rows[0]
                      ? [{ before: t().lastKeptShort, value: props.rows[0].keptSince.text, after: props.rows[0].keptBy }]
                      : []),
                  ]
            }
            filters={
              props.perDay && !props.query && !props.cursor ? (
                <Spark values={props.perDay} label={t().keptPerDay({ days: props.perDay.length })} />
              ) : undefined
            }
            selection={
              selected().length > 0
                ? {
                    count: t().selected({ count: selected().length }),
                    actions: [
                      {
                        label: t().downloadSelection,
                        icon: "download",
                        disabled: download.loading(),
                        onClick: () => void download.mutate(),
                      },
                    ],
                    clear: { label: t().clearSelection, onClick: () => setSelected([]) },
                  }
                : undefined
            }
          />
        }
      >
        {/* the hero's place (DP's hero band takes it): how many are kept with their real trend, then one line of exceptions */}
        {/* one line of exceptions under the hero, only while there is one */}
        <Show when={orphaned().length > 0}>
          <Band label={t().title}>
            <Text>
              <Text tone="warn" weight="medium">
                ● {t().orphanedCount({ count: orphaned().length })}
              </Text>{" "}
              <Text muted>{[...new Set(orphaned().map((row) => row.mailboxName))].join(", ")}</Text>
            </Text>
          </Band>
        </Show>
        <Show
          when={props.failure === null}
          fallback={<Failed text={props.failure ?? t().loadFailed} onRetry={() => void swapPage(location.href)} />}
        >
          <Table
            label={t().title}
            rows={props.rows}
            rowKey={rowKey}
            select={{
              selected: selected(),
              onChange: setSelected,
              all: t().selectAll,
              row: (row) => t().selectRow({ subject: row.subject }),
            }}
            open={(row) => ({ href: row.href })}
            empty={
              props.query
                ? {
                    icon: "search-off",
                    text: t().noMatches({ query: props.query }),
                    action: { label: t().clearSearch, icon: "x", href: keptListHref({}) },
                  }
                : { icon: "lock", text: `${t().empty} ${t().emptyDescription}` }
            }
            phone={(row) => ({
              mark: keptMark(row.mailboxDeleted),
              lines: [row.subject, `${row.mailboxName} · ${row.sender}`],
              time: row.keptSince.text,
              marks: row.mailboxDeleted ? <Chip status="warn">{t().deletedMailbox}</Chip> : undefined,
            })}
            // the widths fit beside the admin bar from 1024 px on; below that the table becomes `phone` rows
            columns={[
              // columns that drop give way from the last one as the table gets narrower: the sender first, then who
              // kept it, then the mailbox; the conversation and since when stay
              {
                title: t().columnConversation,
                width: { min: 220, default: 300 },
                cell: (row) => (
                  <Inline>
                    <Mark {...keptMark(row.mailboxDeleted)} />
                    <Text>{row.subject}</Text>
                  </Inline>
                ),
              },
              {
                title: t().columnMailbox,
                width: { min: 180, default: 210 },
                cell: (row) =>
                  row.mailboxDeleted ? (
                    // the name stays; its state is a dot and a word (the status row counts these rows)
                    <Inline>
                      <Text>{row.mailboxName}</Text>
                      <Chip status="warn">{t().deletedShort}</Chip>
                    </Inline>
                  ) : (
                    row.mailboxName
                  ),
                drop: true,
              },
              {
                title: t().columnKeptBy,
                width: { min: 150, default: 170 },
                cell: (row) => (
                  <Inline>
                    <Avatar name={row.keptBy} decorative />
                    <Text>{row.keptBy}</Text>
                  </Inline>
                ),
                drop: true,
              },
              {
                title: t().columnSender,
                width: { min: 150, default: 180 },
                cell: (row) => (
                  <Inline>
                    <Avatar name={row.sender} decorative />
                    <Text>{row.sender}</Text>
                  </Inline>
                ),
                drop: true,
              },
              {
                title: t().columnKeptSince,
                width: { min: 100, default: 110 },
                align: "end",
                cell: (row) => (
                  <time dateTime={row.keptSince.iso} title={row.keptSince.title}>
                    {row.keptSince.text}
                  </time>
                ),
              },
            ]}
          />
          <Show when={props.cursor || props.nextCursor}>
            <Bar
              end={
                <>
                  <Show when={props.cursor}>
                    <Button icon="chevrons-left" href={keptListHref({ q: props.query })}>
                      {t().firstPage}
                    </Button>
                  </Show>
                  <Show when={props.nextCursor}>
                    {(next) => (
                      <Button href={keptListHref({ q: props.query, cursor: next() })} forward>
                        {t().nextPage}
                      </Button>
                    )}
                  </Show>
                </>
              }
            />
          </Show>
          <Text type="meta" muted>
            {t().description}
          </Text>
        </Show>
      </Pane>
    </AdminWorkspace>
  );
}
