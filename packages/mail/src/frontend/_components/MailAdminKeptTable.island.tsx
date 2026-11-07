import { mutation } from "@k2b/stdlib/solid";
import { Button, Checkbox, DataTable, type DataTableColumn, Placeholder, prompts, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import { mailKeptAdminMessages } from "../kept-admin-messages";
import { downloadKeptConversations } from "./kept-admin-download";

/** One kept conversation, already formatted by the page so the first render matches the server. */
export type KeptTableRow = {
  mailboxId: string;
  conversationId: string;
  href: string;
  mailboxName: string;
  mailboxDeleted: boolean;
  subject: string;
  senderName: string | null;
  senderAddress: string | null;
  date: string;
  dateTitle: string | null;
  dateTime: string | null;
  keptBy: string;
  keptSince: string;
  keptSinceTitle: string;
  keptSinceTime: string;
};

const rowKey = (row: KeptTableRow) => `${row.mailboxId}/${row.conversationId}`;

export default function MailAdminKeptTable(props: { rows: KeptTableRow[]; emptyTitle: string; emptyDescription: string | null }) {
  const locale = useLocale();
  const t = createMemo(() => mailKeptAdminMessages.resolve([locale()]).t);
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const toggle = (key: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const allSelected = () => props.rows.length > 0 && props.rows.every((row) => selected().has(rowKey(row)));
  const someSelected = () => selected().size > 0 && !allSelected();
  const download = mutation.create<void, void>({
    mutation: (_, { abortSignal }) =>
      downloadKeptConversations(
        props.rows.filter((row) => selected().has(rowKey(row))),
        t().downloadFailed,
        abortSignal,
      ),
    onSuccess: () => toast.success(t().downloadStarted),
    onError: (error) => prompts.error(error.message, { title: t().downloadFailed }),
  });

  const sender = (row: KeptTableRow) => (
    <div class="min-w-0">
      <p class="truncate text-primary">{row.senderName ?? row.senderAddress ?? t().unknownSender}</p>
      <Show when={row.senderName && row.senderAddress}>
        <p class="truncate font-mono text-[10px] text-dimmed">{row.senderAddress}</p>
      </Show>
    </div>
  );
  const mailbox = (row: KeptTableRow) => (
    <div class="min-w-0">
      <p class="truncate text-secondary">{row.mailboxName}</p>
      <Show when={row.mailboxDeleted}>
        <p class="text-[10px] text-dimmed">{t().deletedMailbox}</p>
      </Show>
    </div>
  );
  const columns = createMemo<DataTableColumn<KeptTableRow>[]>(() => [
    { id: "select", header: "", headerClass: "w-px", cellClass: "w-px" },
    { id: "mailbox", header: t().columnMailbox, value: (row) => row.mailboxName },
    { id: "subject", header: t().columnSubject, value: (row) => row.subject },
    { id: "sender", header: t().columnSender, value: (row) => row.senderAddress ?? "" },
    { id: "date", header: t().columnDate, value: (row) => row.dateTime ?? "" },
    { id: "keptBy", header: t().columnKeptBy, value: (row) => row.keptBy },
    { id: "keptSince", header: t().columnKeptSince, value: (row) => row.keptSinceTime },
  ]);

  return (
    <Show
      when={props.rows.length > 0}
      fallback={
        <Placeholder
          state={props.emptyDescription ? "empty" : "no-results"}
          icon={props.emptyDescription ? "ti ti-lock" : undefined}
          title={props.emptyTitle}
          description={props.emptyDescription ?? undefined}
        />
      }
    >
      <div class="flex min-h-10 flex-wrap items-center justify-between gap-2 px-3 pb-2" data-kept-selection-bar>
        <span class="text-xs text-dimmed" aria-live="polite">
          {t().selected({ count: selected().size })}
        </span>
        <div class="flex flex-wrap gap-2">
          <Show when={selected().size > 0}>
            <Button variant="subtle" size="sm" onClick={() => setSelected(new Set<string>())}>
              {t().clearSelection}
            </Button>
          </Show>
          <Button
            variant="secondary"
            size="sm"
            disabled={selected().size === 0}
            loading={download.loading()}
            onClick={() => void download.mutate()}
          >
            <i class="ti ti-download" aria-hidden="true" /> {t().downloadSelection}
          </Button>
        </div>
      </div>
      <div class="hidden sm:block">
        <DataTable
          class="overflow-x-auto"
          rows={props.rows}
          columns={columns()}
          getRowId={rowKey}
          hoverRows
          ariaLabel={t().title}
          scrollPreserveKey="mail-admin-kept"
          renderHeader={({ col, render }) =>
            col.id === "select" ? (
              <Checkbox
                aria-label={t().selectAll}
                value={allSelected()}
                indeterminate={someSelected()}
                onValueChange={(on) => setSelected(new Set(on ? props.rows.map(rowKey) : []))}
              />
            ) : (
              render()
            )
          }
          renderCell={({ row, col }) => {
            if (col.id === "select")
              return (
                <Checkbox
                  aria-label={t().selectRow({ subject: row.subject })}
                  value={selected().has(rowKey(row))}
                  onValueChange={(on) => toggle(rowKey(row), on)}
                />
              );
            if (col.id === "mailbox") return mailbox(row);
            if (col.id === "subject")
              return (
                <a href={row.href} class="block max-w-md truncate font-medium text-primary hover:underline" data-kept-open>
                  {row.subject}
                </a>
              );
            if (col.id === "sender") return sender(row);
            if (col.id === "date")
              return (
                <time class="whitespace-nowrap text-secondary" dateTime={row.dateTime ?? undefined} title={row.dateTitle ?? undefined}>
                  {row.date}
                </time>
              );
            if (col.id === "keptBy") return <span class="whitespace-nowrap text-secondary">{row.keptBy}</span>;
            if (col.id === "keptSince")
              return (
                <time class="whitespace-nowrap text-secondary" dateTime={row.keptSinceTime} title={row.keptSinceTitle}>
                  {row.keptSince}
                </time>
              );
            return "";
          }}
        />
      </div>
      {/* Phones get a list: one conversation per row, the facts that decide whether to open it underneath. */}
      <ul class="flex flex-col sm:hidden" aria-label={t().title}>
        <For each={props.rows}>
          {(row) => (
            <li class="flex items-start gap-3 px-3 py-2.5">
              <Checkbox
                class="pt-0.5"
                aria-label={t().selectRow({ subject: row.subject })}
                value={selected().has(rowKey(row))}
                onValueChange={(on) => toggle(rowKey(row), on)}
              />
              <a href={row.href} class="min-w-0 flex-1" data-kept-open>
                <span class="flex items-baseline justify-between gap-2">
                  <span class="truncate text-sm font-medium text-primary">{row.subject}</span>
                  <time class="shrink-0 text-[11px] text-dimmed" dateTime={row.dateTime ?? undefined}>
                    {row.date}
                  </time>
                </span>
                <span class="block truncate text-xs text-secondary">{row.senderName ?? row.senderAddress ?? t().unknownSender}</span>
                <span class="block truncate text-[11px] text-dimmed">
                  {row.mailboxName} · {t().keptSince({ date: row.keptSince, name: row.keptBy })}
                </span>
              </a>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
