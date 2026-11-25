import { useLocale } from "@k2b/ui";
import { Bar, Button, Empty, Failed, Pane, StatusRow, Table, Text } from "@k2b/ui/v2";
import { Show } from "solid-js";
import type { PulseBase } from "../../contracts";
import type { SavedQueriesPage, SavedQuery } from "../../service/saved-queries";
import { usePulseMessages } from "../use-messages";
import { buildPulseWorkspaceHref } from "../workspace/routes";
import BaseFrame, { baseHref } from "./BaseFrame";
import { useScreenMessages } from "./messages";

export const QUERIES_PER_PAGE = 50;

export type QueriesScreenProps = {
  bases: PulseBase[];
  baseId: string;
  sourceCount: number;
  /** The page of saved queries the address names; null when it could not be read. */
  page: SavedQueriesPage | null;
  offset: number;
  dateConfig: { timeZone: string; locale: string };
};

/** The line of SQL that says most about a query: its SELECT, else its first line. */
const excerpt = (sql: string) => sql.split("\n").find((line) => /^\s*SELECT\b/i.test(line))?.trim() ?? sql.trim().split("\n")[0] ?? "";

/** The saved queries of a base, newest change first; a row opens the query in the console. */
export default function QueriesScreen(props: QueriesScreenProps) {
  const t = usePulseMessages();
  const words = useScreenMessages();
  const locale = useLocale();
  const base = () => props.bases.find((entry) => entry.id === props.baseId)?.name ?? t().appName;
  const time = (value: string) =>
    new Intl.DateTimeFormat(locale(), { timeZone: props.dateConfig.timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  const pageHref = (offset: number) => `${baseHref(props.baseId, "queries")}${offset > 0 ? `?offset=${offset}` : ""}`;
  const open = (query: SavedQuery) => ({ href: buildPulseWorkspaceHref({ baseId: props.baseId, state: { view: "sql", queryId: query.id } }) });
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
      <Pane
        label={words().queries}
        scrollKey="pulse-queries"
        status={<StatusRow lead={props.page ? words().queriesCount({ count: props.page.total }) : words().queries} />}
      >
        <Show when={props.page} fallback={<Failed text={t().sqlSavedLoadFailed} onRetry={() => location.reload()} />}>
          {(page) => (
            <>
              <Show when={page().total > 0} fallback={<Empty icon="bookmark" text={t().sqlSavedEmpty({ base: base() })} action={newQuery} />}>
                <Table
                  label={words().queries}
                  rows={page().items}
                  rowKey={(query) => query.id}
                  open={open}
                  phone={(query) => ({ lines: [query.name, excerpt(query.sql)], time: time(query.updatedAt) })}
                  columns={[
                    { title: t().name, width: { min: 240, default: 520 }, cell: (query) => ({ lines: [query.name, excerpt(query.sql)] }) },
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
                      <Button icon="chevron-left" disabled={props.offset === 0} href={props.offset > 0 ? pageHref(Math.max(0, props.offset - QUERIES_PER_PAGE)) : undefined}>
                        {words().queriesBack}
                      </Button>
                      <Button icon="chevron-right" disabled={page().nextOffset === null} href={page().nextOffset !== null ? pageHref(page().nextOffset ?? 0) : undefined}>
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
