import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { createMemo, createSignal, For, Show, onCleanup, onMount } from "solid-js";
import { createNavigation, AppWorkspace, Button, DataTable, Dropdown, StatusBadge, SegmentedControl, prompts, useLocale } from "@k2b/ui";
import { files } from "@k2b/stdlib/browser";
import Papa from "papaparse";
import type { Bundle } from "../contracts";
import type { database } from "../service/database";
import type { QuerySummary, SavedQuery } from "../saved-queries";
import { LIMITS } from "../contracts";
import { Editor } from "./Editor";
import { client, checked, displayError, KitRequestError } from "./client";
import { databaseMessages } from "../database-messages";
import { queryMessages } from "./query-messages";
import { cellText, queryResult, tableSchema } from "./query-results";
import type { DatabaseRequest } from "../database-contracts";
type State = Awaited<ReturnType<typeof database.status>>;
type Result = {
  columns: string[];
  data: Record<string, unknown>[];
  sql: string;
  duration: number;
};
export default function QueryConsole(props: {
  project: Bundle;
  state: State;
  initial: SavedQuery | null;
  queries: QuerySummary[];
  hasNext: boolean;
}) {
  const locale = useLocale(),
    t = () => queryMessages.resolve([locale()]).t;
  const admin = props.project.permission === "admin",
    id = props.project.id;
  const api = client.projects[":id"].database,
    queryApi = client.projects[":id"].queries;
  const [state, setState] = createSignal(props.state);
  const [base, setBase] = createSignal<SavedQuery | null>(props.initial);
  const [text, setText] = createSignal(props.initial?.sql ?? "");
  const [queries, setQueries] = createSignal(props.queries),
    [queryPage, setQueryPage] = createSignal(1),
    [hasNext, setHasNext] = createSignal(props.hasNext);
  const [table, setTable] = createSignal(""),
    [tablePage, setTablePage] = createSignal(0),
    [view, setView] = createSignal<"sql" | "data" | "schema">("sql");
  const [result, setResult] = createSignal<Result>(),
    [tableResult, setTableResult] = createSignal<Result>(),
    [schema, setSchema] = createSignal<Record<string, unknown>[]>([]);
  const [panel, setPanel] = createSignal<"results" | "tables">("results");
  const [catalog, setCatalog] = createSignal<{ name: string; rows?: number; columns: { name: string; type: string }[] }[]>([]);
  const [loadingCatalog, setLoadingCatalog] = createSignal(false);
  let catalogAbort: AbortController | undefined;
  const [error, setError] = createSignal(""),
    [running, setRunning] = createSignal(false),
    [saving, setSaving] = createSignal(false),
    [refreshing, setRefreshing] = createSignal(false),
    [loadingTable, setLoadingTable] = createSignal(false);
  const dirty = createMemo(() => text() !== (base()?.sql ?? ""));
  const tables = () => state().tables?.filter((row) => row.type === "table");
  const ready = () => state().status === "ready" && state().enabled && state().globallyEnabled;
  const abort = new AbortController();
  let execution: AbortController | undefined, tableAbort: AbortController | undefined;
  let selection = 0,
    listRequest = 0;
  function stop() {
    execution?.abort();
    execution = undefined;
    setRunning(false);
  }
  function report(e: unknown) {
    if (abort.signal.aborted) return;
    if (e instanceof KitRequestError && e.message === databaseMessages.resolve([locale()]).t.request) {
      setError(t().failed);
      return;
    }
    if (e instanceof KitRequestError && e.code === "DB_STALE") {
      stop();
      catalogAbort?.abort();
      setCatalog([]);
      setLoadingCatalog(false);
      tableAbort?.abort();
      setResult(undefined);
      setTableResult(undefined);
      setSchema([]);
      setState((s) => ({ ...s, status: "provisioning" }));
      setError(t().stale);
    } else setError(e instanceof KitRequestError && e.code === "REVISION_CONFLICT" ? t().conflict : displayError(e, locale()));
  }
  const leave = (e: BeforeUnloadEvent) => {
    if (dirty() || saving()) {
      e.preventDefault();
      e.returnValue = "";
    }
  };
  onMount(() => {
    window.addEventListener("beforeunload", leave);
    onCleanup(() => window.removeEventListener("beforeunload", leave));
  });
  onCleanup(() => {
    abort.abort();
    catalogAbort?.abort();
    stop();
    tableAbort?.abort();
  });
  async function discard() {
    return (
      !dirty() ||
      Boolean(
        await prompts.confirm(t().discardBody, {
          title: t().discard,
          confirmText: t().discard,
        }),
      )
    );
  }
  function url(query?: string) {
    history.replaceState(null, "", `/app/kit/${id}/database${query ? `?query=${encodeURIComponent(query)}` : ""}`);
  }
  async function openQuery(query?: QuerySummary, sql = "") {
    if (saving() || !(await discard())) return;
    const token = ++selection,
      draft = text();
    try {
      const next = query
        ? await checked(await queryApi[":queryId"].$get({ param: { id, queryId: query.id } }, { init: { signal: abort.signal } }))
        : null;
      if (token !== selection || abort.signal.aborted || text() !== draft) return;
      stop();
      setBase(next);
      setText(next?.sql ?? sql);
      setView("sql");
      setResult(undefined);
      setError("");
      url(next?.id);
    } catch (e) {
      report(e);
    }
  }
  async function list(page = queryPage()) {
    const token = ++listRequest;
    const response = await checked(
      await queryApi.$get({ param: { id }, query: { page: String(page) } }, { init: { signal: abort.signal } }),
    );
    if (abort.signal.aborted || token !== listRequest) return;
    setQueries(response.items);
    setQueryPage(page);
    setHasNext(response.hasNext);
  }
  async function showCatalog() {
    setPanel("tables");
    catalogAbort?.abort();
    const controller = new AbortController();
    catalogAbort = controller;
    setCatalog([]);
    setLoadingCatalog(true);
    setError("");
    try {
      for (const item of tables() ?? []) {
        const response = await call(
          { operation: "schema.get", table: String(item.name) },
          AbortSignal.any([abort.signal, controller.signal]),
        );
        if (controller.signal.aborted) return;
        const columns = tableSchema.parse(response).columns;
        setCatalog((rows) => [
          ...rows,
          { name: String(item.name), rows: typeof item.row_count === "number" ? item.row_count : undefined, columns },
        ]);
      }
    } catch (e) {
      if (!controller.signal.aborted) report(e);
    } finally {
      if (catalogAbort === controller) setLoadingCatalog(false);
    }
  }
  async function refresh() {
    if (refreshing()) return;
    setRefreshing(true);
    try {
      const next = await checked(await api.$get({ param: { id }, query: { diagnostics: "true" } }, { init: { signal: abort.signal } }));
      if (abort.signal.aborted) return;
      if (next.generation !== state().generation || next.status !== "ready") {
        stop();
        tableAbort?.abort();
        setResult(undefined);
        setTableResult(undefined);
        setSchema([]);
      }
      catalogAbort?.abort();
      setCatalog([]);
      setLoadingCatalog(false);
      setState(next);
      if (panel() === "tables") await showCatalog();
      await list();
      setError("");
    } catch (e) {
      report(e);
    } finally {
      setRefreshing(false);
    }
  }
  onMount(() => void refresh());
  async function call(request: DatabaseRequest, signal: AbortSignal) {
    return checked(await api.call.$post({ param: { id }, json: { generation: state().generation, request } }, { init: { signal } }));
  }
  async function run() {
    if (!ready() || running()) return;
    setPanel("results");
    catalogAbort?.abort();
    setLoadingCatalog(false);
    if (!text().trim() || text().length > LIMITS.text) {
      setError(t().sqlLength);
      return;
    }
    const controller = new AbortController();
    execution = controller;
    setRunning(true);
    setResult(undefined);
    setError("");
    setView("sql");
    const sql = text(),
      started = performance.now();
    try {
      const raw = await call({ operation: "query", sql, params: [] }, AbortSignal.any([abort.signal, controller.signal]));
      const parsed = queryResult.parse(raw);
      if (controller.signal.aborted || execution !== controller) return;
      setResult({
        data: parsed.data,
        columns: parsed.columns ?? Object.keys(parsed.data[0] ?? {}),
        sql,
        duration: performance.now() - started,
      });
    } catch (e) {
      if (!controller.signal.aborted) report(e);
    } finally {
      if (execution === controller) {
        execution = undefined;
        setRunning(false);
      }
    }
  }
  async function browse(name: string, page = 0, tab: "data" | "schema" = "data") {
    tableAbort?.abort();
    const controller = new AbortController();
    tableAbort = controller;
    setPanel("results");
    setTable(name);
    setTablePage(page);
    setView(tab);
    setTableResult(undefined);
    setSchema([]);
    setLoadingTable(true);
    setError("");
    const started = performance.now();
    try {
      const response = await call(
        tab === "schema"
          ? { operation: "schema.get", table: name }
          : {
              operation: "rows.list",
              table: name,
              query: { limit: 50, offset: page * 50, order: "id.asc" },
            },
        AbortSignal.any([abort.signal, controller.signal]),
      );
      if (controller.signal.aborted) return;
      if (tab === "schema") setSchema(tableSchema.parse(response).columns);
      else {
        const parsed = queryResult.parse(response);
        setTableResult({
          columns: parsed.columns ?? Object.keys(parsed.data[0] ?? {}),
          data: parsed.data,
          sql: "",
          duration: performance.now() - started,
        });
      }
    } catch (e) {
      if (!controller.signal.aborted) report(e);
    } finally {
      if (tableAbort === controller) setLoadingTable(false);
    }
  }
  async function save() {
    if (!admin || saving()) return;
    if (!text().trim() || text().length > LIMITS.text) {
      setError(t().sqlLength);
      return;
    }
    setSaving(true);
    try {
      const current = base();
      const name = !current
        ? (
            await prompts.form({
              title: t().save,
              fields: {
                name: {
                  type: "text",
                  label: t().name,
                  default: "",
                  required: true,
                  maxLength: 120,
                },
              },
            })
          )?.name
        : current.name;
      if (name === null || name === undefined) return;
      const input = { name: name.trim(), sql: text() };
      let target = current;
      if (!target) {
        const matches = await checked(await queryApi.$get({ param: { id }, query: { page: "1", name: input.name } }));
        const existing = matches.items[0];
        if (existing) {
          if (!(await prompts.confirm(t().overwriteBody, { title: `${t().overwrite}: ${existing.name}`, confirmText: t().overwrite })))
            return;
          target = { ...existing, sql: "" };
        }
      }
      const saved = !target
        ? await checked(await queryApi.$post({ param: { id }, json: input }))
        : await checked(
            await queryApi[":queryId"].$put({
              param: { id, queryId: target.id },
              json: { ...input, revision: target.revision },
            }),
          );
      if (text() === input.sql) setText(saved.sql);
      setBase(saved);
      url(saved.id);
      setError("");
      await list(1);
    } catch (e) {
      report(e);
    } finally {
      setSaving(false);
    }
  }
  async function renameQuery(query: QuerySummary) {
    if (!admin || saving()) return;
    setSaving(true);
    try {
      const fields = await prompts.form({
        title: t().rename,
        fields: { name: { type: "text", label: t().name, default: query.name, required: true, maxLength: 120 } },
      });
      if (!fields || fields.name.trim() === query.name) return;
      const current = await checked(await queryApi[":queryId"].$get({ param: { id, queryId: query.id } }));
      if (current.revision !== query.revision) {
        setError(t().conflict);
        return;
      }
      const renamed = await checked(
        await queryApi[":queryId"].$put({
          param: { id, queryId: query.id },
          json: { name: fields.name, sql: current.sql, revision: query.revision },
        }),
      );
      if (base()?.id === query.id) setBase(renamed);
      await list();
    } catch (e) {
      report(e);
    } finally {
      setSaving(false);
    }
  }
  async function remove(query: QuerySummary) {
    if (saving() || !admin) return;
    if (
      !(await prompts.confirm(t().deleteBody, {
        title: `${t().remove}: ${query.name}`,
        variant: "danger",
        confirmText: t().remove,
      }))
    )
      return;
    if (query.id === base()?.id && !(await discard())) return;
    setSaving(true);
    try {
      await checked(
        await queryApi[":queryId"].$delete({
          param: { id, queryId: query.id },
          json: { revision: query.revision },
        }),
      );
      if (base()?.id === query.id) {
        setBase(null);
        setText("");
        setResult(undefined);
        url();
      }
      await list(1);
    } catch (e) {
      report(e);
    } finally {
      setSaving(false);
    }
  }
  const shown = () => (view() === "sql" ? result() : tableResult());
  function exportCsv() {
    const value = shown();
    if (!value) return;
    files.downloadFileFromContent(
      "\uFEFF" +
        Papa.unparse(
          {
            fields: value.columns,
            data: value.data.map((row) => value.columns.map((key) => (row[key] === null ? "" : cellText(row[key])))),
          },
          { delimiter: ";" },
        ),
      "query-result.csv",
      "text/csv;charset=utf-8",
    );
  }
  const metrics = () => (
    <Show when={shown()}>
      {(value) => (
        <>
          <StatusBadge tone="neutral" icon="ti ti-table" label={`${value().data.length} ${t().rows}`} />
          <StatusBadge tone="neutral" icon="ti ti-clock" title={t().duration} label={`${Math.round(value().duration)} ms`} />
        </>
      )}
    </Show>
  );
  const resultPanel = () => (
    <section class="kit-sql-results" aria-label={t().result}>
      <Show when={view() === "sql" || tablePage() > 0 || tableResult()?.data.length === 50}>
        <div class="kit-sql-toolbar kit-sql-result-toolbar">
          <Show when={view() === "sql"}>
            <SegmentedControl
              size="sm"
              ariaLabel={t().result}
              value={panel}
              onValueChange={(value) => (value === "tables" ? void showCatalog() : setPanel("results"))}
              options={[
                { value: "results", label: t().result, icon: "ti ti-terminal" },
                { value: "tables", label: t().catalog, icon: "ti ti-schema", disabled: !ready() },
              ]}
            />
          </Show>
          <Show when={view() === "sql" && panel() === "results"}>{metrics()}</Show>
          <Show when={view() === "sql" && panel() === "results"}>
            <Dropdown.Root items={[{ label: t().export, icon: "ti ti-download", disabled: !shown()?.data.length, action: exportCsv }]}>
              <Dropdown.Trigger iconOnly label={t().resultActions}>
                <i class="ti ti-dots" aria-hidden="true" />
              </Dropdown.Trigger>
            </Dropdown.Root>
          </Show>
          <Show when={view() === "data" && (tablePage() > 0 || tableResult()?.data.length === 50)}>
            <span class="kit-sql-hint">
              {t().page} {tablePage() + 1}
            </span>
            <Button variant="ghost" disabled={tablePage() === 0 || loadingTable()} onClick={() => void browse(table(), tablePage() - 1)}>
              {t().previous}
            </Button>
            <Button
              variant="ghost"
              disabled={loadingTable() || tableResult()?.data.length !== 50}
              onClick={() => void browse(table(), tablePage() + 1)}
            >
              {t().next}
            </Button>
          </Show>
        </div>
      </Show>

      <Show when={error()}>
        <p role="alert" class="kit-sql-error">
          {error()}
        </p>
      </Show>
      <Show when={panel() === "tables"}>
        <div class="kit-sql-catalog">
          <For each={catalog()}>
            {(item) => (
              <section class="kit-sql-schema">
                <header class="kit-sql-schema-header">
                  <h2>
                    <i class="ti ti-table" aria-hidden="true" /> {item.name}
                  </h2>
                  <Show when={item.rows !== undefined}>
                    <StatusBadge tone="neutral" icon={null} label={`${item.rows} ${t().rows}`} />
                  </Show>
                  <Button
                    variant="ghost"
                    onClick={() => void openQuery(undefined, `SELECT * FROM "${item.name.replaceAll('"', '""')}" LIMIT 100;`)}
                  >
                    {t().open}
                  </Button>
                </header>
                <dl class="kit-sql-columns">
                  <For each={item.columns}>
                    {(column) => (
                      <div>
                        <dt>{column.name}</dt>
                        <dd>{column.type}</dd>
                      </div>
                    )}
                  </For>
                </dl>
              </section>
            )}
          </For>
          <Show when={!loadingCatalog() && !catalog().length && !error()}>
            <p class="kit-sql-hint">{t().noTables}</p>
          </Show>
        </div>
        <Show when={loadingCatalog()}>
          <p role="status" class="kit-sql-hint">
            {t().working}
          </p>
        </Show>
      </Show>
      <Show when={panel() === "results"}>
        <Show when={view() === "sql" && result() && result()?.sql !== text()}>
          <p class="kit-sql-hint">{t().changed}</p>
        </Show>
        <Show when={!error()}>
          <Show
            when={Boolean(shown()?.columns.length)}
            fallback={
              <p role="status" class="kit-sql-hint">
                {loadingTable() ? t().working : shown() ? t().empty : t().idle}
              </p>
            }
          >
            <DataTable
              surface="paper"
              rows={shown()?.data ?? []}
              columns={(shown()?.columns ?? []).map((key) => ({
                id: key,
                header: key,
                value: (row: Record<string, unknown>) => cellText(row[key]),
              }))}
              empty={loadingTable() ? t().working : shown() ? t().empty : t().idle}
            />
          </Show>
        </Show>
      </Show>
    </section>
  );
  const footer = () => (
    <>
      <AppWorkspace.SidebarItem href={`/app/kit/${id}`} icon="ti ti-player-play">
        {t().app}
      </AppWorkspace.SidebarItem>
      <Show when={admin}>
        <AppWorkspace.SidebarItem href={`/app/kit/${id}/edit`} icon="ti ti-code">
          {t().edit}
        </AppWorkspace.SidebarItem>
      </Show>
    </>
  );
  const navigation = () => (
    <>
      <AppWorkspace.SidebarItem href={`/app/kit/${id}`} icon="ti ti-arrow-left">
        {props.project.name}
      </AppWorkspace.SidebarItem>
      <AppWorkspace.SidebarItem active={view() === "sql"} icon="ti ti-terminal" onClick={() => setView("sql")}>
        {t().title}
      </AppWorkspace.SidebarItem>
      <AppWorkspace.SidebarItem icon="ti ti-plus" tone="success" disabled={saving()} onClick={() => void openQuery()}>
        {t().newQuery}
      </AppWorkspace.SidebarItem>
      <AppWorkspace.SidebarSection title={t().tables}>
        <For each={tables() ?? []}>
          {(row) => (
            <AppWorkspace.SidebarItem
              icon="ti ti-table"
              active={table() === row.name && view() !== "sql"}
              disabled={!ready()}
              onClick={() => void browse(String(row.name))}
            >
              {String(row.name)}
              {typeof row.row_count === "number" ? ` · ${row.row_count}` : ""}
            </AppWorkspace.SidebarItem>
          )}
        </For>
        <Show when={tables()?.length === 0}>
          <p class="p-2 text-sm">{t().noTables}</p>
        </Show>
      </AppWorkspace.SidebarSection>
      <Show when={queries().length > 0 || queryPage() > 1}>
        <AppWorkspace.SidebarSection title={t().queries}>
          <For each={queries()}>
            {(q) => (
              <AppWorkspace.SidebarItem
                active={base()?.id === q.id && view() === "sql"}
                icon="ti ti-file-code"
                disabled={saving()}
                onClick={() => void openQuery(q)}
                actions={
                  admin ? (
                    <AppWorkspace.SidebarItemActions visibility="hover">
                      <Dropdown.Root
                        items={[
                          { label: t().rename, icon: "ti ti-pencil", action: () => void renameQuery(q) },
                          {
                            label: t().remove,
                            icon: "ti ti-trash",
                            variant: "danger",
                            action: () => void remove(q),
                          },
                        ]}
                      >
                        <Dropdown.Trigger iconOnly label={t().actions}>
                          <i class="ti ti-dots" aria-hidden="true" />
                        </Dropdown.Trigger>
                      </Dropdown.Root>
                    </AppWorkspace.SidebarItemActions>
                  ) : undefined
                }
              >
                {q.name}
              </AppWorkspace.SidebarItem>
            )}
          </For>
          <Show when={queryPage() > 1}>
            <Button variant="ghost" onClick={() => void list(queryPage() - 1).catch(report)}>
              {t().back}
            </Button>
          </Show>
          <Show when={hasNext()}>
            <Button variant="ghost" onClick={() => void list(queryPage() + 1).catch(report)}>
              {t().more}
            </Button>
          </Show>
        </AppWorkspace.SidebarSection>
      </Show>
    </>
  );
  const mobileNavigation = createNavigation({
    items: () => [
      { id: "app", label: props.project.name, icon: "ti ti-arrow-left", href: `/app/kit/${id}` },
      { id: "sql", label: t().title, icon: "ti ti-terminal", action: "sql", active: view() === "sql" },
      { id: "new", label: t().newQuery, icon: "ti ti-plus", action: "new", disabled: saving() },
      {
        id: "tables",
        label: t().tables,
        children: (tables() ?? []).map((row) => ({
          id: `table:${row.name}`,
          label: String(row.name),
          icon: "ti ti-table",
          action: `table:${row.name}`,
          badge: typeof row.row_count === "number" ? row.row_count : undefined,
          active: table() === row.name && view() !== "sql",
          disabled: !ready(),
        })),
      },
      {
        id: "queries",
        label: t().queries,
        children: [
          ...queries().map((q) => ({
            id: `query:${q.id}`,
            label: q.name,
            icon: "ti ti-file-code",
            action: `query:${q.id}`,
            active: base()?.id === q.id && view() === "sql",
            disabled: saving(),
            actions: admin
              ? [
                  { id: `rename:${q.id}`, action: `rename:${q.id}`, label: t().rename, icon: "ti ti-pencil" },
                  { id: `remove:${q.id}`, action: `remove:${q.id}`, label: t().remove, icon: "ti ti-trash" },
                ]
              : [],
          })),
          ...(queryPage() > 1 ? [{ id: "back", label: t().back, action: "back", icon: "ti ti-arrow-left" }] : []),
          ...(hasNext() ? [{ id: "more", label: t().more, action: "more", icon: "ti ti-arrow-right" }] : []),
        ],
      },
      ...(admin ? [{ id: "edit", label: t().edit, icon: "ti ti-code", href: `/app/kit/${id}/edit` }] : []),
    ],
    onAction: async (action) => {
      if (action === "sql") setView("sql");
      else if (action === "new") await openQuery();
      else if (action === "back") await list(queryPage() - 1).catch(report);
      else if (action === "more") await list(queryPage() + 1).catch(report);
      else if (action.startsWith("table:")) await browse(action.slice(6));
      else {
        const [kind, queryId] = action.split(":");
        const q = queries().find((q) => q.id === queryId);
        if (!q) return;
        if (kind === "query") await openQuery(q);
        else if (kind === "rename") await renameQuery(q);
        else if (kind === "remove") await remove(q);
      }
    },
  });
  return (
    <AppWorkspace mobileSurface="flush" class="kit-sql-workspace">
      <WorkspaceNavigationProvider navigation={mobileNavigation} label={t().title} />
      <AppWorkspace.Sidebar>
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarBody>{navigation()}</AppWorkspace.SidebarBody>
          <AppWorkspace.SidebarFooter>{footer()}</AppWorkspace.SidebarFooter>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
      <AppWorkspace.Content>
        <AppWorkspace.Main scroll={false} class="kit-sql-main">
          <header class="kit-sql-header">
            <div>
              <h1>{view() === "sql" ? t().title : table()}</h1>
              <p>
                {props.project.name}
                {view() === "sql" ? ` · ${base()?.name ?? t().draft}` : ""}
                {view() === "sql" && dirty() ? ` · ${t().dirty}` : ""}
              </p>
            </div>
            <div class="kit-sql-toolbar">
              <Show when={admin && view() === "sql"}>
                <Button variant="secondary" onClick={() => void save()} disabled={saving() || !text().trim() || (!dirty() && !!base())}>
                  <i class="ti ti-device-floppy" aria-hidden="true" /> {t().save}
                </Button>
              </Show>
              <Button variant="ghost" onClick={refresh} loading={refreshing()}>
                <i class="ti ti-refresh" aria-hidden="true" /> {t().refresh}
              </Button>
            </div>
          </header>
          <Show when={!ready()}>
            <p role="status" class="p-2">
              {t().notReady}
            </p>
          </Show>
          <Show
            when={view() === "sql"}
            fallback={
              <div class="kit-sql-toolbar">
                <SegmentedControl
                  size="sm"
                  ariaLabel={t().tableView}
                  value={() => (view() === "schema" ? "schema" : "data")}
                  onValueChange={(value) => void browse(table(), 0, value)}
                  options={[
                    { value: "data", label: t().data },
                    { value: "schema", label: t().schema },
                  ]}
                />
                <Show when={view() === "data"}>{metrics()}</Show>
                <div class="kit-sql-toolbar-end">
                  <Dropdown.Root
                    items={[
                      {
                        label: t().open,
                        icon: "ti ti-code",
                        action: () => void openQuery(undefined, `SELECT * FROM "${table().replaceAll('"', '""')}" LIMIT 100;`),
                      },
                      {
                        label: t().export,
                        icon: "ti ti-download",
                        disabled: view() !== "data" || !tableResult()?.data.length,
                        action: exportCsv,
                      },
                    ]}
                  >
                    <Dropdown.Trigger iconOnly label={t().tableActions}>
                      <i class="ti ti-dots" aria-hidden="true" />
                    </Dropdown.Trigger>
                  </Dropdown.Root>
                </div>
              </div>
            }
          >
            <div class="kit-sql-toolbar">
              <Button onClick={run} disabled={!ready() || running() || !text().trim()}>
                <i class="ti ti-player-play" aria-hidden="true" /> {running() ? t().working : t().run}
              </Button>
              <Show when={running()}>
                <Button
                  variant="ghost"
                  onClick={() => {
                    stop();
                    setError(t().stopped);
                  }}
                >
                  {t().cancel}
                </Button>
              </Show>
            </div>
          </Show>
          <div class="kit-sql-editor" hidden={view() !== "sql"}>
            <Editor path={t().sql} language="sql" content={text()} onChange={setText} onSave={() => void save()} onRun={() => void run()} />
          </div>
          <Show when={view() === "schema"}>
            <Show when={error()}>
              <p role="alert" class="kit-sql-error">
                {error()}
              </p>
            </Show>
            <DataTable
              surface="paper"
              rows={schema()}
              getRowId={(r) => String(r.name)}
              columns={[
                {
                  id: "name",
                  header: t().column,
                  value: (r) => cellText(r.name),
                },
                {
                  id: "type",
                  header: t().type,
                  value: (r) => cellText(r.type),
                },
                {
                  id: "constraints",
                  header: t().constraints,
                  value: (r) =>
                    Object.entries(r)
                      .filter(([k]) => k !== "name" && k !== "type")
                      .map(([k, v]) => `${k}: ${cellText(v)}`)
                      .join(" · "),
                },
              ]}
              empty={loadingTable() ? t().working : t().empty}
            />
          </Show>
          <Show when={view() === "data"}>{resultPanel()}</Show>
        </AppWorkspace.Main>
      </AppWorkspace.Content>
      <AppWorkspace.BottomDrawer id="query-results" class="kit-sql-drawer" open={view() === "sql"} height="lg" minHeight={160}>
        <Show when={view() === "sql"}>{resultPanel()}</Show>
      </AppWorkspace.BottomDrawer>
    </AppWorkspace>
  );
}
