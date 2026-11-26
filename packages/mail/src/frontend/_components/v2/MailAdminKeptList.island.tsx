import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { swapPage } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import {
  Avatar,
  Bar,
  Button,
  Chip,
  Failed,
  Inline,
  Input,
  Mark,
  type NavProps,
  Pane,
  Path,
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
    return props.query ? t().filteredCount({ count: props.rows.length, total: props.total }) : t().count({ count: props.total });
  };
  // only what is not fine speaks up: conversations whose mailbox is gone live on as Cloud's kept copy alone
  const orphaned = () => props.rows.filter((row) => row.mailboxDeleted).length;
  const search = (text: string) => void swapPage(keptListHref({ q: text.trim() }));

  return (
    <AdminWorkspace
      nav={props.nav}
      head={
        <Bar
          start={<Path label={t().tabsLabel} items={[{ label: t().areaMail, href: "/admin/mail" }, { label: t().tabKept }]} />}
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
            select={
              props.rows.length > 0
                ? {
                    label: t().selectAll,
                    checked: selected().length === 0 ? false : selected().length === props.rows.length ? true : "mixed",
                    onChange: (all) => setSelected(all ? props.rows.map(rowKey) : []),
                  }
                : undefined
            }
            filters={orphaned() > 0 ? <Chip status="warn">{t().orphanedCount({ count: orphaned() })}</Chip> : undefined}
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
              {
                title: t().columnConversation,
                width: { min: 220, default: 320 },
                cell: (row) => (
                  <Inline>
                    <Mark {...keptMark(row.mailboxDeleted)} />
                    <Text>{row.subject}</Text>
                  </Inline>
                ),
              },
              {
                title: t().columnMailbox,
                width: { min: 130, default: 160 },
                cell: (row) =>
                  row.mailboxDeleted ? (
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
                title: t().columnSender,
                width: { min: 150, default: 190 },
                cell: (row) => (
                  <Inline>
                    <Avatar name={row.sender} decorative />
                    <Text>{row.sender}</Text>
                  </Inline>
                ),
                drop: true,
              },
              {
                title: t().columnDate,
                width: { min: 90, default: 110 },
                cell: (row) =>
                  row.date ? (
                    <time dateTime={row.date.iso} title={row.date.title}>
                      {row.date.text}
                    </time>
                  ) : (
                    "–"
                  ),
                drop: true,
              },
              {
                title: t().columnKeptBy,
                width: { min: 150, default: 180 },
                cell: (row) => (
                  <Inline>
                    <Avatar name={row.keptBy} decorative />
                    <Text>{row.keptBy}</Text>
                  </Inline>
                ),
                drop: true,
              },
              {
                title: t().columnKeptSince,
                width: { min: 100, default: 120 },
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
