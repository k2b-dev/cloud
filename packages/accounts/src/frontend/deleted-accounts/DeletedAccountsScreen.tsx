import { useLocale } from "@k2b/ui";
import { Bar, Button, Facts, FilterBar, Input, ListOrder, Notice, Pane, Section, StatusRow, Table, Text, Workspace } from "@k2b/ui/v2";
import { createMemo, createSignal, Show } from "solid-js";
import { usePageSwap } from "@/frontend/lib/page-swap";
import AccountsNav from "../AccountsNav";
import { kindHref } from "../activity/kind";
import { useActivityMessages } from "../activity/messages";
import { useListMessages } from "../list-messages";
import { type AccountsMessages, useAccountsMessages } from "../messages";
import { useDeletedMessages } from "./messages";
import { type DeletedState, deletedHref, deletedQuery } from "./query";

export type DeletedRow = {
  id: string;
  name: string;
  uid: string;
  mail: string | null;
  provider: string | null;
  profile: string | null;
  reason: string;
  /** When it was deleted, formatted by the server. */
  deleted: string;
};

/** The open entry with its recorded metadata, each value already written as text by the server. */
export type DeletedOpen = DeletedRow & { meta: { key: string; value: string }[] };

export type DeletedAccountsScreenProps = {
  state: DeletedState;
  page: number;
  pages: number;
  total: number;
  rows: DeletedRow[];
  /** The entry the address names, and that entry when it stands on this page. */
  entry: string | null;
  open: DeletedOpen | null;
  /** Parameters of the address that did not apply, already worded. */
  ignored: string | null;
  pendingRequests: number;
};

const reasonLabel = (t: AccountsMessages, reason: string): string =>
  ({
    ipa_expired_demoted: t.deletedReasonIpaDemoted,
    ipa_expired_deleted: t.deletedReasonIpaDeleted,
    sync_out_of_scope_demoted: t.deletedReasonSyncDemoted,
    sync_out_of_scope_deleted: t.deletedReasonSyncDeleted,
    guest_expired_deleted: t.deletedReasonGuestExpired,
    local_user_expired_deleted: t.deletedReasonLocalExpired,
    manual_demote: t.deletedReasonManualDemote,
    manual_delete: t.deletedReasonManualDelete,
  })[reason] ?? reason;

/**
 * Deleted accounts on v2, the kind "Gelöschte Konten" of the activity page: the reason as a filter statement, the search in the head, one row per account, and the open
 * entry with its metadata beside the list. Every change shows the list again from the server.
 */
export default function DeletedAccountsScreen(props: DeletedAccountsScreenProps) {
  const locale = useLocale();
  const t = useAccountsMessages();
  const d = useDeletedMessages();
  const words = useListMessages();
  const activity = useActivityMessages();
  const { showChanges, openPage } = usePageSwap();
  const query = createMemo(() => deletedQuery(locale()));
  const [state, setState] = createSignal<DeletedState>(props.state);
  const [ignored, setIgnored] = createSignal(props.ignored);
  const [refreshing, setRefreshing] = createSignal(false);
  const changed = () => query().serialize(state()).toString() !== query().serialize(query().reset()).toString();
  const href = (entry?: string) => deletedHref(query(), state(), props.page, entry);
  const providerLabel = (value: string | null) => (value === "ipa" ? "FreeIPA" : value === "local" ? t().local : value);
  const profileLabel = (value: string | null) => (value === "user" ? t().fullAccount : value === "guest" ? t().guestAccount : value);
  const kind = (row: DeletedRow) => [providerLabel(row.provider), profileLabel(row.profile)].filter(Boolean).join(" · ") || "–";

  /** The bar wrote the address; a new filter starts at page 1 with nothing open, and the server shows the list. */
  const change = (next: DeletedState) => {
    // another kind is another list: it opens with its own filters, none of these
    if (next.filters.kind !== "deleted") return void openPage(kindHref(next.filters.kind), { replace: true });
    setState(next);
    setRefreshing(true);
    const params = new URLSearchParams(location.search);
    params.delete("page");
    params.delete("entry");
    history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`);
    void showChanges();
  };
  const search = (text: string) => {
    const next = query().set(state(), "q", text.trim());
    if (next) {
      setRefreshing(true);
      void openPage(deletedHref(query(), next));
    }
  };

  return (
    <Workspace
      sidebar={<AccountsNav active="deleted-accounts" pendingRequests={props.pendingRequests} />}
      head={
        <Bar
          start={<Text type="body">{activity().activity}</Text>}
          end={
            <Input
              type="search"
              icon="search"
              label={d().searchLabel}
              placeholder={d().searchLabel}
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
      <Pane.Split>
        <Pane
          label={t().deletedAccounts}
          scrollKey="accounts-deleted"
          status={
            <>
              <FilterBar
                query={query()}
                state={state()}
                onChange={change}
                icons={{ kind: "activity", reason: "filter" }}
                results={t().deletedAccountCount({ count: props.total })}
              />
              <StatusRow
                lead={t().deletedAccountCount({ count: props.total })}
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
            label={t().deletedAccounts}
            rows={props.rows}
            rowKey={(row) => row.id}
            sticky
            current={props.entry ?? undefined}
            open={(row) => ({ href: href(row.id) })}
            empty={
              changed() || state().search
                ? {
                    icon: "filter-off",
                    text: d().noMatches,
                    action: { label: words().resetFilters, icon: "filter-off", href: kindHref("deleted") },
                  }
                : { icon: "user-off", text: t().noDeletedAccounts }
            }
            phone={(row) => ({ lines: [row.name, reasonLabel(t(), row.reason)], time: row.deleted })}
            columns={[
              { title: t().account, width: { min: 160, default: 220 }, cell: (row) => ({ lines: [row.name, row.uid] }) },
              { title: t().reason, width: { min: 180, default: 280 }, cell: (row) => reasonLabel(t(), row.reason) },
              { title: t().deleted, width: { min: 130, default: 150 }, cell: (row) => row.deleted, drop: true },
              { title: t().email, width: { min: 160, default: 220 }, cell: (row) => row.mail || "–", drop: true },
              { title: t().accountType, cell: (row) => kind(row), drop: true },
            ]}
          />
          <Show when={props.pages > 1}>
            <Bar
              start={<Text type="meta">{words().pageOf({ page: props.page, pages: props.pages })}</Text>}
              end={
                <>
                  <Button icon="chevron-left" href={deletedHref(query(), state(), props.page - 1)} disabled={props.page <= 1}>
                    {words().previous}
                  </Button>
                  <Button href={deletedHref(query(), state(), props.page + 1)} disabled={props.page >= props.pages} forward>
                    {words().next}
                  </Button>
                </>
              }
            />
          </Show>
        </Pane>
        {props.entry ? (
          <Pane
            detail
            label={props.open?.name ?? t().details}
            width={{ min: 340, default: 420 }}
            back={{ label: t().deletedAccounts, href: href() }}
            head={
              <Bar
                start={<Text type="lead">{props.open?.name ?? t().details}</Text>}
                end={<Button variant="ghost" icon="x" label={t().close} href={href()} />}
              />
            }
          >
            <Show
              when={props.open}
              fallback={
                <Notice tone="warn" icon="alert-triangle">
                  {d().entryGone}
                </Notice>
              }
            >
              {(entry) => (
                <>
                  <Section title={t().details}>
                    <Facts
                      items={[
                        { label: t().account, value: entry().name },
                        { label: "UID", value: entry().uid, mono: true, copy: entry().uid },
                        { label: t().email, value: entry().mail || "–" },
                        { label: t().provider, value: providerLabel(entry().provider) || "–" },
                        { label: t().profile, value: profileLabel(entry().profile) || "–" },
                        { label: t().reason, value: reasonLabel(t(), entry().reason) },
                        { label: t().deleted, value: entry().deleted },
                      ]}
                    />
                  </Section>
                  <Section title={t().metadata} count={entry().meta.length}>
                    <Show when={entry().meta.length > 0} fallback={<Text muted>{t().noMetadata}</Text>}>
                      <Facts items={entry().meta.map((item) => ({ label: item.key, value: item.value, mono: true }))} />
                    </Show>
                  </Section>
                </>
              )}
            </Show>
          </Pane>
        ) : undefined}
      </Pane.Split>
    </Workspace>
  );
}
