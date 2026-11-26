import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { swapPage } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { Avatar, Bar, Button, Failed, Inline, Input, type NavProps, Pane, Path, StatusRow, Table, Text, useLocale, useToast } from "@k2b/ui/v2";
import { createMemo, createSignal, Show } from "solid-js";
import { keptListHref } from "../../admin-sections";
import { mailKeptAdminMessages } from "../../kept-admin-messages";
import { downloadKeptConversations } from "../kept-admin-download";

/** One kept conversation as the list shows it; the page words and formats it, so the first render matches the server. */
export type MailAdminKeptRow = {
  mailboxId: string;
  conversationId: string;
  href: string;
  mailboxName: string;
  mailboxDeleted: boolean;
  subject: string;
  sender: { name: string | null; address: string | null };
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
 * Cloud administration › Mail › Kept on v2: the search in the head, how many are kept as the status row, one row per
 * kept conversation that opens its record, and a selection that downloads as one JSON file. The server searches and
 * pages; a search or a page is an address.
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
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const lead = () => {
    if (props.total === null) return t().title;
    return props.query ? t().filteredCount({ count: props.rows.length, total: props.total }) : t().count({ count: props.total });
  };
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
            selection={
              selected().length > 0
                ? {
                    count: t().selected({ count: number(selected().length) }),
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
        <Show when={props.failure === null} fallback={<Failed text={props.failure ?? t().loadFailed} onRetry={() => void swapPage(location.href)} />}>
          <Table
            label={t().title}
            rows={props.rows}
            rowKey={rowKey}
            select={{ selected: selected(), onChange: setSelected, all: t().selectAll, row: (row) => t().selectRow({ subject: row.subject }) }}
            open={(row) => ({ href: row.href })}
            empty={
              props.query
                ? { icon: "search-off", text: t().noMatches({ query: props.query }), action: { label: t().clearSearch, icon: "x", href: keptListHref({}) } }
                : { icon: "lock", text: `${t().empty} ${t().emptyDescription}` }
            }
            phone={(row) => ({
              lines: [row.subject, `${row.sender.name ?? row.sender.address ?? t().unknownSender} · ${row.mailboxName}`],
              avatar: { name: row.sender.name ?? row.sender.address ?? "?" },
              time: row.date?.text,
              marks: row.mailboxDeleted ? <Text tone="warn">{t().deletedMailbox}</Text> : undefined,
            })}
            columns={[
              {
                title: t().columnSubject,
                width: { min: 220, default: 360 },
                cell: (row) => ({
                  lines: [
                    <Text weight="strong">{row.subject}</Text>,
                    <Show when={row.mailboxDeleted} fallback={row.mailboxName}>
                      <Text tone="warn">
                        {row.mailboxName} · {t().deletedMailbox}
                      </Text>
                    </Show>,
                  ],
                }),
              },
              {
                title: t().columnSender,
                width: { min: 180, default: 240 },
                cell: (row) =>
                  row.sender.name && row.sender.address
                    ? { lines: [row.sender.name, <Text muted>{row.sender.address}</Text>] }
                    : (row.sender.name ?? row.sender.address ?? <Text muted>{t().unknownSender}</Text>),
                drop: true,
              },
              {
                title: t().columnDate,
                width: { min: 96, default: 120 },
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
                width: { min: 150, default: 190 },
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
                width: { min: 110, default: 130 },
                cell: (row) => (
                  <time dateTime={row.keptSince.iso} title={row.keptSince.title}>
                    {row.keptSince.text}
                  </time>
                ),
                drop: true,
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
