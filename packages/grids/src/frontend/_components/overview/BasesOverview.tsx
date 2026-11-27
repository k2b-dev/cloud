import { type LinkNavigateEvent, navigateTo } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Empty, Input, List, Pane, Row, Section, Table, Tabs, Text, Tiles, Workspace } from "@k2b/ui/v2";
import { createMemo, createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { isServer } from "solid-js/web";
import type { PublicBase } from "../../../api/public-dto";
import { APPS_PER_PAGE, BASES_PAGE_PATH, BASES_PER_PAGE, type BasesState, basesHref, basesQuery, withParam } from "./bases-query";
import { kindMark } from "../frame/kind-marks";
import CreateBaseDialog, { type BaseTemplate, BLANK } from "./CreateBaseDialog";
import { overviewMessages } from "./messages";

type BaseStats = { tableCount: number; lastActivityAt: string };

type RecentTable = {
  id: string;
  baseId: string;
  baseName: string;
  name: string;
  icon: string | null;
  lastActivityAt: string;
};

type UsableApp = { id: string; name: string; icon: string | null; baseName: string };

export type BasesOverviewProps = {
  state: BasesState;
  page: number;
  bases: PublicBase[];
  total: number;
  templates: BaseTemplate[];
  /** Keyed by public base id; bases outside the scanned set show no stats. */
  baseStats: Record<string, BaseStats>;
  recentTables: RecentTable[];
  /** Published apps the person may use across all bases; `page` is set while the full list is open. */
  apps: { items: UsableApp[]; total: number; page: number | null };
  /** The template the create dialog opens with (`blank` for none); null while it is closed. */
  create: string | null;
  dateConfig: DateContext;
};

/** v2 names Tabler icons without the `ti ti-` classes v1 stores. */
const icon = (value: string | null | undefined, fallback: string) => (value ? value.replace(/^ti ti-/, "") : fallback);

/**
 * Grids' first page on v2: the bases the person can open, searched and paged in the address, with the apps they may
 * use and the tables changed last beside them. Without any base or app, the templates are the first picture.
 */
export default function BasesOverview(props: BasesOverviewProps) {
  const locale = useLocale();
  const t = () => overviewMessages.resolve([locale()]).t;
  const query = createMemo(() => basesQuery(locale()));
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const relative = (value: string) => dates.formatDateTimeRelative(value, props.dateConfig);
  const lastChange = (baseId: string) => {
    const stats = props.baseStats[baseId];
    return stats ? relative(stats.lastActivityAt) : undefined;
  };
  const pages = () => Math.max(1, Math.ceil(props.total / BASES_PER_PAGE));
  const appPages = () => Math.max(1, Math.ceil(props.apps.total / APPS_PER_PAGE));
  const searching = () => Boolean(props.state.search);
  const hasApps = () => props.apps.total > 0;
  // Without any base or usable app the templates are the useful first screen.
  const firstRun = () => !searching() && props.total === 0 && !hasApps() && props.apps.page === null;

  // The open dialog lives in the address (`?new=`); the address of this page with or without it.
  const here = () => (isServer ? basesHref(query(), props.state, props.page) : `${location.pathname}${location.search}`);
  const [create, setCreate] = createSignal(props.create);
  const openCreate = (event: LinkNavigateEvent, start: string) => {
    event.push(withParam(here(), "new", start), { scroll: "manual" });
    setCreate(start);
  };
  const closeCreate = () => {
    history.replaceState(history.state, "", withParam(here(), "new", null));
    setCreate(null);
  };
  onMount(() => {
    const restore = () => setCreate(new URL(location.href).searchParams.get("new"));
    addEventListener("popstate", restore);
    onCleanup(() => removeEventListener("popstate", restore));
  });

  const search = (text: string) => {
    const next = query().set(props.state, "q", text.trim());
    if (next) navigateTo(basesHref(query(), next));
  };
  const newBase = {
    label: t().newBase,
    icon: "plus",
    href: withParam(BASES_PAGE_PATH, "new", BLANK),
    onNavigate: (event: LinkNavigateEvent) => openCreate(event, BLANK),
  };

  const lead = () =>
    props.bases.length < props.total
      ? t().basesOf({ count: number(props.bases.length), total: number(props.total) })
      : t().basesCount({ count: number(props.total) });

  /** An app as a row with its mark in the apps' colour, its base as the quiet note. */
  const appRow = (app: UsableApp) => (
    <Row mark={kindMark("app", app.icon)} lines={[app.name]} meta={app.baseName} href={`/apps/${app.id}`} />
  );
  /** The count of a list as a quiet line over it (12 px meta), not as a figure. */
  const countBar = (words: string) => <Bar start={<Text type="meta">{words}</Text>} />;

  const pager = (page: number, count: number, href: (page: number) => string) => (
    <Show when={count > 1}>
      <Bar
        start={<Text type="meta">{t().pageOf({ page, pages: count })}</Text>}
        end={
          <>
            <Button icon="chevron-left" href={href(page - 1)} disabled={page <= 1}>
              {t().previous}
            </Button>
            <Button href={href(page + 1)} disabled={page >= count} forward>
              {t().next}
            </Button>
          </>
        }
      />
    </Show>
  );

  const basesPane = () => (
    <Pane
      label={t().bases}
      scrollKey="grids-bases"
      status={countBar(searching() ? `${lead()} · ${t().searchBases} „${props.state.search}“` : lead())}
    >
      <Table
        label={t().bases}
        rows={props.bases}
        rowKey={(base) => base.id}
        open={(base) => ({ href: `/app/grids/${base.id}` })}
        empty={
          searching()
            ? { icon: "search", text: t().noMatchingBases, action: { label: t().resetSearch, icon: "x", href: BASES_PAGE_PATH } }
            : { icon: "database-plus", text: t().noBases, action: newBase }
        }
        // one line a base on the desktop; its description stands in the phone's second line
        phone={(base) => ({
          mark: kindMark("base"),
          lines: [base.name, base.description || t().tableCount({ count: props.baseStats[base.id]?.tableCount ?? 0 })],
          time: lastChange(base.id),
        })}
        columns={[
          {
            title: t().name,
            width: { min: 200, default: 360 },
            mark: () => kindMark("base"),
            cell: (base) => base.name,
          },
          {
            title: t().tables,
            width: { min: 90, default: 110 },
            align: "end",
            cell: (base) => {
              const stats = props.baseStats[base.id];
              return stats ? number(stats.tableCount) : "–";
            },
          },
          {
            title: t().lastChange,
            align: "end",
            cell: (base) => lastChange(base.id) ?? "–",
          },
        ]}
      />
      {pager(props.page, pages(), (page) => basesHref(query(), props.state, page))}
    </Pane>
  );

  const sidePane = () => (
    <Pane side label={t().recentlyChanged} width={{ min: 280, default: 360 }}>
      <Show when={hasApps()}>
        <Section
          icon="app-window"
          title={t().apps}
          count={number(props.apps.total)}
          more={
            props.apps.total > props.apps.items.length
              ? { label: t().allApps({ count: number(props.apps.total) }), href: withParam(BASES_PAGE_PATH, "apps", "1"), forward: true }
              : undefined
          }
        >
          <List label={t().apps}>{props.apps.items.map(appRow)}</List>
        </Section>
      </Show>
      <Section icon="clock" title={t().recentlyChanged} summary={t().recentTablesDescription}>
        <Show when={props.recentTables.length > 0} fallback={<Empty icon="table" text={t().noTablesDescription} />}>
          <List label={t().recentlyChanged}>
            {props.recentTables.map((table) => (
              <Row
                mark={kindMark("table", table.icon)}
                lines={[table.name, table.baseName]}
                time={relative(table.lastActivityAt)}
                href={`/app/grids/${table.baseId}/table/${table.id}`}
              />
            ))}
          </List>
        </Show>
      </Section>
    </Pane>
  );

  const appsPane = (page: number) => (
    <Pane label={t().allAppsTitle} scrollKey="grids-apps" status={countBar(t().appsCount({ count: number(props.apps.total) }))}>
      <Show when={props.apps.items.length > 0} fallback={<Empty icon="app-window" text={t().noAppsDescription} />}>
        <List label={t().apps}>{props.apps.items.map(appRow)}</List>
      </Show>
      {pager(page, appPages(), (next) => withParam(BASES_PAGE_PATH, "apps", String(next)))}
    </Pane>
  );

  const firstRunPane = () => (
    <Pane label={t().getStarted}>
      <Section icon="sparkles" title={t().getStarted} summary={t().firstRunDescription}>
        <Tiles
          label={t().templates}
          items={[
            ...props.templates.map((template) => ({
              icon: icon(template.icon, "template"),
              title: template.name,
              meta: template.description,
              href: withParam(BASES_PAGE_PATH, "new", template.id),
            })),
            { icon: "plus", title: t().blankBase, meta: t().blankBaseDescription, href: withParam(BASES_PAGE_PATH, "new", BLANK) },
          ]}
        />
      </Section>
    </Pane>
  );

  return (
    <Workspace
      head={
        <Bar
          start={
            hasApps() ? (
              <Tabs
                label={t().views}
                items={[
                  { label: t().bases, count: number(props.total), href: BASES_PAGE_PATH, current: props.apps.page === null },
                  {
                    label: t().apps,
                    count: number(props.apps.total),
                    href: withParam(BASES_PAGE_PATH, "apps", "1"),
                    current: props.apps.page !== null,
                  },
                ]}
              />
            ) : (
              <Text type="body">{firstRun() ? t().getStarted : t().bases}</Text>
            )
          }
          end={
            <>
              <Show when={!firstRun() && props.apps.page === null}>
                {/* k2b-ui slot (#4270, Z2): the head's search folds to an icon that opens over the head */}
                <Input
                  type="search"
                  icon="search"
                  label={t().searchBases}
                  placeholder={t().searchBasesPlaceholder}
                  value={props.state.search ?? ""}
                  onKeyDown={(event) => {
                    if (event.isComposing) return;
                    const input = event.currentTarget as HTMLInputElement;
                    if (event.key === "Enter") search(input.value);
                    if (event.key === "Escape" && input.value) search("");
                  }}
                />
              </Show>
              <Button variant="primary" icon="plus" href={newBase.href} onNavigate={newBase.onNavigate}>
                {t().newBase}
              </Button>
            </>
          }
        />
      }
      primary={newBase}
    >
      <Switch
        fallback={
          <Pane.Split>
            {basesPane()}
            {sidePane()}
          </Pane.Split>
        }
      >
        <Match when={props.apps.page}>{(page) => appsPane(page())}</Match>
        <Match when={firstRun()}>{firstRunPane()}</Match>
      </Switch>
      <CreateBaseDialog start={create()} templates={props.templates} onClose={closeCreate} />
    </Workspace>
  );
}
