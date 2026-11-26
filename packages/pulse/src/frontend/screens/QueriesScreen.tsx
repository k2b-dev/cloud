import { principalLabel } from "@k2b/cloud/access/ui";
import type { Principal } from "@k2b/cloud/contracts";
import type { ServiceAccountKind } from "@k2b/cloud/services";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Empty, Failed, Pane, Table, Text } from "@k2b/ui/v2";
import { Show } from "solid-js";
import type { PulseBase } from "../../contracts";
import type { SavedQueriesPage, SavedQuery } from "../../service/saved-queries";
import { usePulseMessages } from "../use-messages";
import { buildPulseWorkspaceHref } from "../workspace/routes";
import BaseFrame, { baseHref } from "./BaseFrame";
import { useScreenMessages } from "./messages";

export const QUERIES_PER_PAGE = 50;

/** Who changed a saved query, as `resolveDisplayNames` names a person or an agent. */
export type QueryAuthor = { principal: Principal; displayName?: string; serviceAccountKind?: ServiceAccountKind };

/** A saved query's mark: the SQL symbol in the colour Pulse gives queries. */
/**
 * A saved query's mark tells what it reads, from the first view after FROM: measured values, events, states, the
 * hourly rollups or the sources; anything else keeps the plain code mark.
 */
const QUERY_MARKS: Record<string, { icon: string; color: string }> = {
  samples: { icon: "chart-line", color: "#2563eb" },
  rollups: { icon: "chart-bar", color: "#4f46e5" },
  series: { icon: "list-details", color: "#0891b2" },
  events: { icon: "bolt", color: "#d97706" },
  states: { icon: "toggle-right", color: "#7c3aed" },
  sources: { icon: "plug", color: "#059669" },
};
const queryMark = (sql: string) =>
  QUERY_MARKS[/\bFROM\s+([a-z_]+)/i.exec(sql)?.[1]?.toLowerCase() ?? ""] ?? { icon: "file-code", color: "#0d9488" };

export type QueriesScreenProps = {
  bases: PulseBase[];
  baseId: string;
  sourceCount: number;
  /** The page of saved queries the address names; null when it could not be read. */
  page: SavedQueriesPage | null;
  offset: number;
  /** The people and agents who changed the queries, by id, named as the access lists name them. */
  authors: Record<string, QueryAuthor>;
  dateConfig: { timeZone: string; locale: string };
};

/** The line of SQL that says most about a query: its SELECT, else its first line. */
const excerpt = (sql: string) =>
  sql
    .split("\n")
    .find((line) => /^\s*SELECT\b/i.test(line))
    ?.trim() ??
  sql.trim().split("\n")[0] ??
  "";

/** The saved queries of a base, newest change first; a row opens the query in the console. */
export default function QueriesScreen(props: QueriesScreenProps) {
  const t = usePulseMessages();
  const words = useScreenMessages();
  const locale = useLocale();
  const base = () => props.bases.find((entry) => entry.id === props.baseId)?.name ?? t().appName;
  const time = (value: string) =>
    new Intl.DateTimeFormat(locale(), { timeZone: props.dateConfig.timeZone, dateStyle: "medium", timeStyle: "short" }).format(
      new Date(value),
    );
  const pageHref = (offset: number) => `${baseHref(props.baseId, "queries")}${offset > 0 ? `?offset=${offset}` : ""}`;
  const open = (query: SavedQuery) => ({
    href: buildPulseWorkspaceHref({ baseId: props.baseId, state: { view: "sql", queryId: query.id } }),
  });
  const author = (query: SavedQuery) => {
    const id = query.updatedBy ?? query.createdBy;
    const entry = id ? props.authors[id] : undefined;
    return entry ? principalLabel(entry, locale()) : undefined;
  };
  const newQuery = { label: t().sqlNewQuery, icon: "plus", href: baseHref(props.baseId, "sql") };
  return (
    <BaseFrame
      bases={props.bases}
      baseId={props.baseId}
      view="queries"
      sourceCount={props.sourceCount}
      primary={newQuery}
      end={
        <Button variant="primary" icon="plus" href={newQuery.href}>
          {t().sqlNewQuery}
        </Button>
      }
    >
      <Pane label={words().queries} scrollKey="pulse-queries">
        <Show when={props.page} fallback={<Failed text={t().sqlSavedLoadFailed} onRetry={() => location.reload()} />}>
          {(page) => (
            <>
              <Show
                when={page().total > 0}
                fallback={<Empty icon="bookmark" text={t().sqlSavedEmpty({ base: base() })} action={newQuery} />}
              >
                <Table
                  label={words().queries}
                  rows={page().items}
                  rowKey={(query) => query.id}
                  open={open}
                  phone={(query) => ({
                    mark: queryMark(query.sql),
                    lines: [query.name, author(query) ? `${author(query)} · ${time(query.updatedAt)}` : time(query.updatedAt)],
                  })}
                  columns={[
                    {
                      title: t().name,
                      width: { min: 240, default: 520 },
                      mark: (query) => queryMark(query.sql),
                      cell: (query) => ({ lines: [query.name, excerpt(query.sql)] }),
                    },
                    {
                      title: words().changedBy,
                      width: { min: 140, default: 200 },
                      drop: true,
                      avatar: (query) => ({ name: author(query) ?? "?" }),
                      cell: (query) => author(query) ?? "—",
                    },
                    { title: words().updated, drop: true, cell: (query) => time(query.updatedAt) },
                  ]}
                />
              </Show>
              <Show when={props.offset > 0 || page().nextOffset !== null}>
                <Bar
                  start={
                    <Text type="meta" muted>
                      {`${props.offset + 1}–${props.offset + page().items.length} / ${page().total}`}
                    </Text>
                  }
                  end={
                    <>
                      <Button
                        icon="chevron-left"
                        disabled={props.offset === 0}
                        href={props.offset > 0 ? pageHref(Math.max(0, props.offset - QUERIES_PER_PAGE)) : undefined}
                      >
                        {words().queriesBack}
                      </Button>
                      <Button
                        icon="chevron-right"
                        disabled={page().nextOffset === null}
                        href={page().nextOffset !== null ? pageHref(page().nextOffset ?? 0) : undefined}
                      >
                        {words().queriesMore}
                      </Button>
                    </>
                  }
                />
              </Show>
            </>
          )}
        </Show>
      </Pane>
    </BaseFrame>
  );
}
