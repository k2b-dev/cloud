import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Chip,
  Digest,
  Empty,
  Failed,
  FilterBar,
  Inline,
  Input,
  Mark,
  Notice,
  Pane,
  Popover,
  Section,
  Text,
  Workspace,
} from "@k2b/ui/v2";
import type { LookupItem } from "@k2b/ui/v2/list-query";
import { createMemo, createSignal, For, Show } from "solid-js";
import AccountsNav from "../AccountsNav";
import { kindHref } from "../activity/kind";
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
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const changed = () => query().serialize(state()).toString() !== query().serialize(query().reset()).toString();
  const href = (next: AuditState, page = 1) => auditHref(query(), next, { page });

  /** The bar wrote the address; a new filter starts at page 1, and the server shows the log for it. */
  const change = (next: AuditState) => {
    // another kind is another list: it opens with its own filters, none of these
    if (next.filters.kind !== "audit") return void openPage(kindHref(next.filters.kind), { replace: true });
    setState(next);
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
      void openPage(href(next));
    }
  };
  /** The log of one actor: a press on an actor's name narrows the log to that person. */
  const byActor = (userId: string) => {
    const next = query().set(state(), "actor", userId);
    return next ? href(next) : undefined;
  };
  /** The address of the log narrowed to one more filter, for the chips that say what needs a look. */
  const narrowed = (key: "outcome", value: "failed") => {
    const next = query().set(state(), key, value);
    return next ? href(next) : undefined;
  };
  /** Events grouped by their day, in the order the server sent them (newest first). */
  const days = createMemo(() => {
    const groups: { day: string; rows: AuditRow[] }[] = [];
    for (const row of props.rows ?? []) {
      const last = groups.at(-1);
      if (last?.day === row.day) last.rows.push(row);
      else groups.push({ day: row.day, rows: [row] });
    }
    return groups;
  });
  /** The event as a sentence: who, what, and the thing it was done to with its mark; a refusal or failure says so. */
  const sentence = (row: AuditRow) => (
    <>
      {row.actor.userId ? (
        <Text weight="strong" href={byActor(row.actor.userId)}>
          {row.actor.label}
        </Text>
      ) : (
        <Text weight="strong">{row.actor.label}</Text>
      )}
      {": "}
      {row.action.label}
      <Show when={row.target.label !== "–"}>
        {" · "}
        <Mark {...targetMark(row.target.type)} />
        {row.target.href ? (
          <Text weight="strong" href={row.target.href}>
            {row.target.label}
          </Text>
        ) : (
          <Text weight="strong">{row.target.label}</Text>
        )}
      </Show>
      <Show when={row.outcome !== "allowed"}>
        {" "}
        {row.outcome === "denied" ? <Chip status="warn">{t().denied}</Chip> : <Chip status="bad">{t().failed}</Chip>}
      </Show>
    </>
  );
  // the days stand in the filter bar ("Zeitraum letzte 30 Tage"); the head says how many and what needs a look
  const lead = () => (props.rows ? words().events({ count: number(props.total) }) : words().loadFailed);

  return (
    <Workspace
      sidebar={<AccountsNav active="activity" pendingRequests={props.pendingRequests} />}
      // k2b-ui gap: head rows (lane DP). The statement and its chips stand in the head, the filters below: two rows.
      head={
        <Bar
          start={
            <Inline>
              <Text weight="strong">{lead()}</Text>
              <Chip status="bad" href={narrowed("outcome", "failed")} pressed={state().filters.outcome === "failed"}>
                {words().failedOnes}
              </Chip>
              <Show when={!props.automatic.shown && props.automatic.hidden > 0}>
                <Popover tip={words().automaticHiddenHint({ count: number(props.automatic.hidden) })}>
                  <Chip icon="robot" href={props.automatic.href}>
                    {words().automaticHidden({ count: number(props.automatic.hidden) })}
                  </Chip>
                </Popover>
              </Show>
            </Inline>
          }
          end={
            <Input
              type="search"
              icon="search"
              label={t().searchAudit}
              placeholder={words().searchShort}
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
              automatic: "robot",
            }}
            names={props.names}
            results={lead()}
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
          <Show
            when={days().length > 0}
            fallback={
              changed() || state().search ? (
                <Empty
                  icon="filter-off"
                  text={words().noMatches}
                  action={{ label: list().resetFilters, icon: "filter-off", href: AUDIT_PAGE_PATH }}
                />
              ) : (
                <Empty icon="clipboard-list" text={t().noAuditEvents} />
              )
            }
          >
            <For each={days()}>
              {(group) => (
                <Section title={group.day} count={number(group.rows.length)}>
                  <Digest
                    label={group.day}
                    activity={group.rows.map((row) => ({
                      person: row.actor.userId ? { name: row.actor.label } : { name: row.actor.label, initials: "S", color: "#475569" },
                      text: sentence(row),
                      // why it was refused or failed, else the action's code for whoever searches the log by it
                      place: row.reason ?? row.action.code,
                      time: row.time,
                    }))}
                  />
                </Section>
              )}
            </For>
          </Show>
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

/** The mark of what an event was done to, in the colour of its kind: a person, a group, an agent, an approval. */
const targetMark = (type: string | null): { icon: string; color?: string } =>
  type === "user"
    ? { icon: "user", color: "#2563eb" }
    : type === "group"
      ? { icon: "users-group", color: "#7c3aed" }
      : type === "service_account" || type === "service_account_credential"
        ? { icon: "robot", color: "#0e7490" }
        : type === "ai_approval"
          ? { icon: "checks", color: "#8e1b6f" }
          : { icon: "target" };
