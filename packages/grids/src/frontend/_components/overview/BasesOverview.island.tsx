import { type DateContext, dates } from "@k2b/stdlib";
import { timed } from "@k2b/stdlib/solid";
import {
  AppWorkspace,
  ButtonLink,
  Dropdown,
  LinkCard,
  Pagination,
  PanelHeader,
  Paper,
  Placeholder,
  prompts,
  Tag,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicBase } from "../../../api/public-dto";
import { errorMessage } from "../utils/api-helpers";
import { openCreateBase } from "./create-base-dialog";
import { overviewMessages } from "./messages";

type TemplateSummary = {
  id: string;
  name: string;
  description: string;
  highlights: [string, string, string];
  icon: string;
};

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

type Props = {
  bases: PublicBase[];
  total: number;
  limit: number;
  offset: number;
  templates: TemplateSummary[];
  initialQuery: string;
  /** Keyed by public base id; search results outside the server-rendered set show no stats. */
  baseStats: Record<string, BaseStats>;
  recentTables: RecentTable[];
  /** Published apps the user may use across all bases; `page` is set while the full list is open. */
  apps: { items: UsableApp[]; total: number; page: number | null; pageSize: number };
  dateConfig: DateContext;
};

/** The object list needs room for a title and a meta line; the overview does not resize. */
const OVERVIEW_LAYOUT = { version: 2 as const, sidebarWidth: 304 };

const setQueryParam = (value: string, page: number) => {
  const url = new URL(window.location.href);
  const trimmed = value.trim();
  if (trimmed) url.searchParams.set("q", trimmed);
  else url.searchParams.delete("q");
  if (page > 1) url.searchParams.set("page", String(page));
  else url.searchParams.delete("page");
  window.history.replaceState({}, "", url.toString());
};

export default function BasesOverview(props: Props) {
  const locale = useLocale();
  const { t } = overviewMessages.resolve([locale()]);
  const [query, setQuery] = createSignal(props.initialQuery);
  const [bases, setBases] = createSignal<PublicBase[]>(props.bases);
  const [total, setTotal] = createSignal(props.total);
  const [offset, setOffset] = createSignal(props.offset);
  const [creatingTemplateId, setCreatingTemplateId] = createSignal<string | null>(null);
  let abortCtl: AbortController | null = null;

  const currentPage = createMemo(() => Math.floor(offset() / props.limit) + 1);
  const totalPages = createMemo(() => Math.ceil(total() / props.limit));
  const paginationBaseUrl = createMemo(() => {
    const q = query().trim();
    return q ? `/app/grids?q=${encodeURIComponent(q)}&page=` : "/app/grids?page=";
  });

  const loadBases = async (value: string, page = 1) => {
    abortCtl?.abort();
    abortCtl = new AbortController();
    const q = value.trim();
    const res = await apiClient.bases.$get(
      {
        query: {
          q,
          limit: String(props.limit),
          offset: String((page - 1) * props.limit),
        },
      },
      { init: { signal: abortCtl.signal } },
    );
    if (!res.ok) throw new Error(await errorMessage(res, t.loadBasesFailed));
    const body = await res.json();
    setBases(body.items);
    setTotal(body.total);
    setOffset(body.offset);
  };
  const searchDebounce = timed.debounce((value: string) => {
    void loadBases(value, 1).catch((e) => {
      if ((e as Error).name !== "AbortError") prompts.error((e as Error).message);
    });
  }, 250);
  onCleanup(() => abortCtl?.abort());

  const [isCreating, setIsCreating] = createSignal(false);
  const createBase = async (template?: TemplateSummary) => {
    if (isCreating()) return;
    setIsCreating(true);
    setCreatingTemplateId(template?.id ?? null);
    try {
      await openCreateBase(t, template);
    } finally {
      setIsCreating(false);
      setCreatingTemplateId(null);
    }
  };
  const createBlank = () => void createBase();
  const createFromTemplate = (template: TemplateSummary) => void createBase(template);

  const onSearchInput = (value: string) => {
    setQuery(value);
    setOffset(0);
    setQueryParam(value, 1);
    searchDebounce.debouncedFn(value);
  };

  const relativeTime = (value: string) => (
    <time datetime={value} title={dates.formatDateTime(value, props.dateConfig)}>
      {dates.formatDateTimeRelative(value, props.dateConfig)}
    </time>
  );

  const createMenuItems = () => [
    {
      sectionLabel: t.start,
      items: [{ label: t.blankBase, description: t.blankBaseDescription, icon: "ti ti-plus", action: createBlank }],
    },
    {
      sectionLabel: t.templates,
      items: props.templates.map((template) => ({
        label: template.name,
        description: template.description,
        icon: template.icon,
        action: () => createFromTemplate(template),
      })),
    },
  ];

  const hasBases = Boolean(props.initialQuery) || props.bases.length > 0;
  const hasApps = props.apps.total > 0;
  // Without any base or usable app the templates are the useful first screen, with their highlights.
  const firstRun = !hasBases && !hasApps && props.apps.page === null;

  const templateCards = () => (
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <For each={props.templates}>
        {(template) => (
          <button
            type="button"
            class="paper p-4 text-left flex items-start gap-3 hover:paper-highlighted transition-all"
            onClick={() => createFromTemplate(template)}
            disabled={isCreating()}
            aria-label={t.createTemplateBase({ name: template.name })}
            aria-busy={creatingTemplateId() === template.id}
          >
            <span class="w-9 h-9 thumbnail bg-[var(--ui-surface-raised)] flex items-center justify-center shrink-0">
              <i class={`${creatingTemplateId() === template.id ? "ti ti-loader-2 animate-spin" : template.icon} text-lg text-primary`} />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-semibold text-primary">{template.name}</span>
              <span class="block text-xs text-dimmed leading-snug">{template.description}</span>
              <span class="mt-2 grid gap-1" role="list" aria-label={t.templateIncludes({ name: template.name })}>
                <For each={template.highlights}>
                  {(highlight) => (
                    <span class="flex items-start gap-1.5 text-xs text-secondary leading-snug" role="listitem">
                      <i class="ti ti-check mt-0.5 shrink-0 text-dimmed" aria-hidden="true" />
                      <span>{highlight}</span>
                    </span>
                  )}
                </For>
              </span>
            </span>
          </button>
        )}
      </For>

      <button
        type="button"
        class="paper p-4 text-left flex items-start gap-3 hover:paper-highlighted transition-all"
        onClick={createBlank}
        disabled={isCreating()}
        aria-busy={isCreating() && creatingTemplateId() === null}
      >
        <span class="w-9 h-9 thumbnail bg-[var(--ui-surface-raised)] flex items-center justify-center shrink-0">
          <i class={`ti ${isCreating() && creatingTemplateId() === null ? "ti-loader-2 animate-spin" : "ti-plus"} text-lg text-primary`} />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block text-sm font-semibold text-primary">{t.blankBase}</span>
          <span class="block text-xs text-dimmed leading-snug">{t.blankBaseDescription}</span>
        </span>
      </button>
    </div>
  );

  const recentTableList = () => (
    <Paper class="grids-overview-list">
      <Show
        when={props.recentTables.length > 0}
        fallback={<Placeholder state="empty" title={t.noTables} description={t.noTablesDescription} icon="ti ti-table" class="min-h-56" />}
      >
        <ol class="grids-overview-tables" aria-label={t.recentlyChanged}>
          <For each={props.recentTables}>
            {(table) => (
              <li>
                <a href={`/app/grids/${table.baseId}/table/${table.id}`} class="grids-overview-table focus-ui">
                  <span class="grids-overview-table-icon k2b-icon-tile app-accent-text" aria-hidden="true">
                    <i class={table.icon ?? "ti ti-table"} />
                  </span>
                  <span class="grids-overview-table-copy">
                    <span class="grids-overview-table-title">{table.name}</span>
                    <span class="grids-overview-table-meta">
                      <i class="ti ti-database" aria-hidden="true" /> {table.baseName}
                    </span>
                  </span>
                  <span class="grids-overview-table-time">{relativeTime(table.lastActivityAt)}</span>
                  <i class="ti ti-chevron-right grids-overview-table-chevron" aria-hidden="true" />
                </a>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </Paper>
  );

  const createMenu = () => (
    <Dropdown.Root items={createMenuItems()} position="bottom-right" width="min(38rem, calc(100vw - 1rem))" label={t.newBase}>
      <Dropdown.Trigger variant="primary" disabled={isCreating()}>
        <i class="ti ti-plus" aria-hidden="true" /> {t.newBase}
        <i class="ti ti-chevron-down" aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );

  const appTiles = () => (
    <ul class="grids-overview-apps" aria-label={t.apps}>
      <For each={props.apps.items}>
        {(app) => (
          <li>
            <LinkCard
              href={`/apps/${app.id}`}
              title={app.name}
              description={app.baseName}
              icon={app.icon ? `ti ti-${app.icon}` : "ti ti-app-window"}
              color="emerald"
            />
          </li>
        )}
      </For>
    </ul>
  );

  const overviewDescription = () =>
    hasApps && hasBases ? t.overviewDescription : hasApps ? t.appsOnlyDescription : t.tablesOnlyDescription;

  const overviewPage = () => (
    <Show
      when={!firstRun}
      fallback={
        <>
          <PanelHeader as="h2" size="lg" title={t.getStarted} subtitle={t.noBasesDescription} actions={createMenu()} />
          {templateCards()}
        </>
      }
    >
      <PanelHeader as="h2" size="lg" title={t.overview} subtitle={overviewDescription()} actions={createMenu()} />
      <div>
        <Tag icon="ti ti-database" size="lg">
          {t.allBases}
        </Tag>
      </div>
      <Show when={hasApps}>
        <section class="grids-overview-section" aria-labelledby="grids-overview-apps-title">
          <PanelHeader
            as="h3"
            title={<span id="grids-overview-apps-title">{t.apps}</span>}
            actions={
              <Show when={props.apps.total > props.apps.items.length}>
                <ButtonLink href="/app/grids?apps=1" variant="text" size="sm">
                  {t.allApps({ count: props.apps.total })}
                </ButtonLink>
              </Show>
            }
          />
          {appTiles()}
        </section>
      </Show>
      <Show when={hasBases}>
        <section class="grids-overview-section" aria-labelledby="grids-overview-tables-title">
          <PanelHeader
            as="h3"
            title={<span id="grids-overview-tables-title">{t.recentlyChanged}</span>}
            subtitle={t.recentTablesDescription}
          />
          {recentTableList()}
        </section>
      </Show>
    </Show>
  );

  const allAppsPage = (page: number) => (
    <>
      <PanelHeader
        as="h2"
        size="lg"
        title={t.allAppsTitle}
        subtitle={t.usableAppCount({ count: props.apps.total })}
        actions={
          <ButtonLink href="/app/grids" variant="secondary">
            <i class="ti ti-arrow-left" aria-hidden="true" /> {t.backToOverview}
          </ButtonLink>
        }
      />
      <Show
        when={props.apps.items.length > 0}
        fallback={<Placeholder state="empty" title={t.noApps} description={t.noAppsDescription} icon="ti ti-app-window" class="min-h-56" />}
      >
        {appTiles()}
      </Show>
      <Pagination currentPage={page} totalPages={Math.ceil(props.apps.total / props.apps.pageSize)} baseUrl="/app/grids?apps=" />
    </>
  );

  return (
    <AppWorkspace mobileSurface="flush" flat class="grids-overview-workspace" resizable={false} layoutState={() => OVERVIEW_LAYOUT}>
      <h1 class="sr-only">Grids</h1>
      <AppWorkspace.Sidebar label={t.bases} mobile="stacked" resizable={false}>
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarBody scrollPreserveKey={false}>
            <Show when={hasBases}>
              <div class="grids-overview-search">
                <TextInput
                  name="grids-base-search"
                  type="search"
                  aria-label={t.searchBases}
                  placeholder={t.searchBasesPlaceholder}
                  icon="ti ti-search"
                  activeIcon="ti ti-search"
                  value={query}
                  onValueChange={onSearchInput}
                  clearable
                  onClear={() => onSearchInput("")}
                />
              </div>
            </Show>
            <AppWorkspace.SidebarSection title={t.bases} count={total()}>
              <Show
                when={bases().length > 0}
                fallback={
                  <Show when={query().trim()} fallback={<Placeholder state="empty" title={t.noBases} icon="ti ti-database-plus" />}>
                    <Placeholder state="empty" title={t.noMatchingBases} description={t.tryDifferentSearch} icon="ti ti-search" />
                  </Show>
                }
              >
                <For each={bases()}>
                  {(base) => {
                    const stats = () => props.baseStats[base.id];
                    return (
                      <AppWorkspace.SidebarItem
                        variant="object"
                        href={`/app/grids/${base.id}`}
                        title={base.description || base.name}
                        description={<Show when={stats()}>{(value) => relativeTime(value().lastActivityAt)}</Show>}
                      >
                        <AppWorkspace.SidebarItemLabel>{base.name}</AppWorkspace.SidebarItemLabel>
                        <Show when={stats()}>
                          {(value) => (
                            <AppWorkspace.SidebarItemMeta>
                              <span class="grids-overview-count" data-zero={value().tableCount === 0 ? "true" : undefined}>
                                <span aria-hidden="true">{value().tableCount.toLocaleString(locale())}</span>
                                <span class="sr-only">{t.tableCount({ count: value().tableCount })}</span>
                              </span>
                            </AppWorkspace.SidebarItemMeta>
                          )}
                        </Show>
                      </AppWorkspace.SidebarItem>
                    );
                  }}
                </For>
              </Show>
            </AppWorkspace.SidebarSection>
            <Pagination currentPage={currentPage()} totalPages={totalPages()} baseUrl={paginationBaseUrl()} />
          </AppWorkspace.SidebarBody>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
      <AppWorkspace.Content>
        <AppWorkspace.Main class="grids-overview-main" width="content">
          <div class="grids-overview-page">
            <Show when={props.apps.page} fallback={overviewPage()}>
              {(page) => allAppsPage(page())}
            </Show>
          </div>
        </AppWorkspace.Main>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
