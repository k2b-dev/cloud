import { useLocale } from "@k2b/ui";
import { Bar, Button, Chip, Failed, FilterBar, Input, ListOrder, Notice, Pane, StatusRow, Table, Text, Workspace } from "@k2b/ui/v2";
import type { LookupItem } from "@k2b/ui/v2/list-query";
import { createMemo, createSignal, Show } from "solid-js";
import AccountsNav from "../AccountsNav";
import { kindHref } from "../activity/kind";
import { useActivityMessages } from "../activity/messages";
import { usePageSwap } from "../lib/page-swap";
import { useListMessages } from "../list-messages";
import { useAccountsMessages } from "../messages";
import { entityLookup } from "./entities";
import { useAuditMessages } from "./messages";
import { AUDIT_PAGE_PATH, type AuditState, auditHref, auditQuery } from "./query";
import type { AuditRow } from "./rows";

export type AuditScreenProps = {
  state: AuditState;
  page: number;
  pages: number;
  total: number;
  /** The events of this page, worded on the server; null when the log could not be read. */
  rows: AuditRow[] | null;
  /** Names of the identities and the action the address filters by, which the server resolved. */
  names: { actor: LookupItem[]; target: LookupItem[]; serviceAccountId: LookupItem[]; action: LookupItem[] };
  /** Whether automatic app entries show, how many are hidden, and the address that turns them on or off. */
  automatic: { shown: boolean; hidden: number; href: string };
  /** Parameters of the address that did not apply, already worded. */
  ignored: string | null;
  pendingRequests: number;
};

/**
 * The audit log on v2, the kind "Protokoll" of the activity page: the time range and the other filters as statements, the search in the head, one row per event.
 * Every change shows the log again from the server, which filters it; automatic app entries stay hidden until shown.
 */
export default function AuditScreen(props: AuditScreenProps) {
  const locale = useLocale();
  const t = useAccountsMessages();
  const words = useAuditMessages();
  const list = useListMessages();
  const activity = useActivityMessages();
  const { showChanges, openPage } = usePageSwap();
  const query = createMemo(() =>
    auditQuery(locale(), {
      actor: entityLookup(["user"]),
      target: entityLookup(["user", "group"]),
      serviceAccount: entityLookup(["service_account"]),
    }),
  );
  const [state, setState] = createSignal<AuditState>(props.state);
  const [ignored, setIgnored] = createSignal(props.ignored);
  const [refreshing, setRefreshing] = createSignal(false);
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const changed = () => query().serialize(state()).toString() !== query().serialize(query().reset()).toString();
  const href = (next: AuditState, page = 1) => auditHref(query(), next, { page, automatic: props.automatic.shown });

  /** The bar wrote the address; a new filter starts at page 1, and the server shows the log for it. */
  const change = (next: AuditState) => {
    // another kind is another list: it opens with its own filters, none of these
    if (next.filters.kind !== "audit") return void openPage(kindHref(next.filters.kind), { replace: true });
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
      void openPage(href(next));
    }
  };
  /** The log of one actor: a press on an actor's name narrows the log to that person. */
  const byActor = (userId: string) => {
    const next = query().set(state(), "actor", userId);
    return next ? href(next) : undefined;
  };
  const outcome = (row: AuditRow) =>
    row.outcome === "allowed" ? (
      <Chip status="ok">{t().allowed}</Chip>
    ) : row.outcome === "denied" ? (
      <Chip status="warn">{t().denied}</Chip>
    ) : (
      <Chip status="bad">{t().failed}</Chip>
    );

  return (
    <Workspace
      sidebar={<AccountsNav active="audit" pendingRequests={props.pendingRequests} />}
      head={
        <Bar
          start={<Text type="body">{activity().activity}</Text>}
          end={
            <Input
              type="search"
              icon="search"
              label={t().searchAudit}
              placeholder={t().searchAudit}
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
        label={t().auditLog}
        scrollKey="accounts-audit"
        status={
          <>
            <FilterBar
              query={query()}
              state={state()}
              onChange={change}
              icons={{
                kind: "activity",
                days: "calendar",
                outcome: "circle-check",
                action: "bolt",
                actor: "user-search",
                target: "target",
                serviceAccountId: "user-key",
                actionGroup: "category",
                provider: "building",
              }}
              names={props.names}
              results={words().events({ count: number(props.total) })}
            />
            <StatusRow
              lead={props.rows ? words().events({ count: number(props.total) }) : words().loadFailed}
              loading={refreshing()}
              filters={<ListOrder query={query()} state={state()} onChange={change} />}
            />
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
        <Show when={props.automatic.shown || props.automatic.hidden > 0}>
          <Notice
            tone="note"
            icon="robot"
            title={words().automatic}
            actions={[{ label: props.automatic.shown ? t().hideAutomatic : t().showAutomatic, href: props.automatic.href }]}
          >
            {props.automatic.shown ? t().automaticAppAuditShown : t().automaticAppAuditHidden({ count: props.automatic.hidden })}
          </Notice>
        </Show>
        {/* k2b-ui gap: virtualized list (lane MW). Until it lands the server pages the list (at most one page of rows in the DOM). */}
        <Show when={props.rows} fallback={<Failed text={words().loadFailed} onRetry={() => void showChanges()} />}>
          {(rows) => (
            <Table
              label={t().auditLog}
              rows={rows()}
              rowKey={(row) => row.id}
              sticky
              empty={
                changed() || state().search
                  ? {
                      icon: "filter-off",
                      text: words().noMatches,
                      action: { label: list().resetFilters, icon: "filter-off", href: AUDIT_PAGE_PATH },
                    }
                  : { icon: "clipboard-list", text: t().noAuditEvents }
              }
              phone={(row) => ({
                lines: [row.action.label, `${row.actor.label} → ${row.target.label}`],
                time: row.time,
                marks: outcome(row),
              })}
              columns={[
                { title: t().time, width: { min: 130, default: 150 }, cell: (row) => row.time },
                {
                  title: t().actor,
                  width: { min: 150, default: 190 },
                  cell: (row) => {
                    const name = row.actor.userId ? <Text href={byActor(row.actor.userId)}>{row.actor.label}</Text> : row.actor.label;
                    return row.actor.provider ? { lines: [name, row.actor.provider] } : name;
                  },
                },
                {
                  title: t().action,
                  width: { min: 180, default: 240 },
                  cell: (row) => ({ lines: [row.action.label, row.action.code] }),
                },
                {
                  title: t().target,
                  width: { min: 150, default: 200 },
                  cell: (row) => ({
                    lines: [row.target.href ? <Text href={row.target.href}>{row.target.label}</Text> : row.target.label, row.target.kind],
                  }),
                  drop: true,
                },
                { title: t().outcome, width: { min: 140, default: 150 }, cell: outcome },
                { title: t().reason, cell: (row) => row.reason ?? "–", drop: true },
              ]}
            />
          )}
        </Show>
        <Show when={props.pages > 1}>
          <Bar
            start={<Text type="meta">{list().pageOf({ page: props.page, pages: props.pages })}</Text>}
            end={
              <>
                <Button icon="chevron-left" href={href(state(), props.page - 1)} disabled={props.page <= 1}>
                  {list().previous}
                </Button>
                <Button href={href(state(), props.page + 1)} disabled={props.page >= props.pages} forward>
                  {list().next}
                </Button>
              </>
            }
          />
        </Show>
      </Pane>
    </Workspace>
  );
}
