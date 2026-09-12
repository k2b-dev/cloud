import { Button, DataTable, Dropdown, NoticeCard, Placeholder, Tabs, useLocale } from "@k2b/ui";
import { files } from "@k2b/stdlib/browser";
import Papa from "papaparse";
import { createResource, createSignal, onCleanup, onMount, Show } from "solid-js";
import { z } from "zod";
import { artifactClient } from "./client";
import { artifactMessages } from "./messages";
import { advancedMessages } from "./advanced-messages";
import { SourceEditor } from "./SourceEditor";

const Rows = z.object({
  data: z
    .array(z.record(z.string(), z.unknown()))
    .nullable()
    .transform((rows) => rows ?? []),
});
const cell = (value: unknown) =>
  value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
export function SqlConsole(props: {
  id: string;
  userId: string;
  initialTable?: string;
  initialStatus: Awaited<ReturnType<typeof artifactClient.databaseStatus>>;
}) {
  const locale = useLocale(),
    t = () => artifactMessages.resolve([locale()]).t,
    a = () => advancedMessages.resolve([locale()]).t;
  const [status, { refetch }] = createResource(() => artifactClient.databaseStatus(props.id), { initialValue: props.initialStatus });
  const [tables, { refetch: reloadTables }] = createResource(
    () => status()?.connected,
    async (ready) =>
      ready
        ? z.array(z.object({ name: z.string() })).parse(await artifactClient.databaseInspect(props.id, { operation: "tables.list" }))
        : [],
  );
  const [text, setText] = createSignal("SELECT 1 AS example"),
    [table, setTable] = createSignal(props.initialTable ?? "");
  const [view, setView] = createSignal("query"),
    [rows, setRows] = createSignal<Record<string, unknown>[]>(),
    [columns, setColumns] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal(""),
    [elapsed, setElapsed] = createSignal(0);
  let controller: AbortController | undefined;
  const key = `assistant-sql:${props.userId}:${props.id}`;
  onMount(() => {
    try {
      setText(localStorage.getItem(key) ?? text());
    } catch {}
  });
  onCleanup(() => controller?.abort());
  function draft(value: string) {
    setText(value);
    try {
      localStorage.setItem(key, value);
    } catch {}
  }
  async function run(mode = view(), selected = table()) {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    setBusy(true);
    setError("");
    setRows(undefined);
    setColumns([]);
    const began = performance.now();
    try {
      const request =
        mode === "query"
          ? { operation: "query", sql: text(), params: [] }
          : mode === "schema"
            ? { operation: "schema.get", table: selected }
            : { operation: "rows.list", table: selected, query: { limit: 100 } };
      const result = await artifactClient.databaseInspect(props.id, request, current.signal);
      if (current !== controller) return;
      const data =
        mode === "schema"
          ? z.object({ columns: z.array(z.record(z.string(), z.unknown())) }).parse(result).columns
          : Rows.parse(result).data;
      setRows(data);
      setColumns([...new Set(data.flatMap((row) => Object.keys(row)))]);
      setElapsed(performance.now() - began);
    } catch (e) {
      if (current === controller) setError(current.signal.aborted ? a().cancelled : e instanceof Error ? e.message : t().REQUEST_FAILED);
    } finally {
      if (current === controller) setBusy(false);
    }
  }
  return (
    <div class="assistant-sql-console">
      <NoticeCard tone="info" title={a().sql} detail={a().queryHelp + " " + a().databaseHelp} />
      <Show
        when={!status.error}
        fallback={
          <Placeholder
            state="error"
            title={t().loadFailed}
            description={String(status.error)}
            action={<Button onClick={() => void refetch()}>{t().retry}</Button>}
          />
        }
      >
        <Show when={status()?.configured} fallback={<NoticeCard tone="warning" title={t().DB_NOT_CONFIGURED} />}>
          <Show when={status()?.unavailable}>
            <NoticeCard tone="warning" title={t().DB_UNREACHABLE} />
          </Show>
          <Show
            when={status()?.connected}
            fallback={
              <Placeholder
                title={a().disconnected}
                action={
                  <Button
                    loading={busy()}
                    onClick={async () => {
                      setBusy(true);
                      setError("");
                      try {
                        await artifactClient.database(props.id, { operation: "connect" });
                        await refetch();
                      } catch (e) {
                        setError(String(e));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {a().connect}
                  </Button>
                }
              />
            }
          >
            <div class="assistant-advanced-toolbar">
              <Tabs
                value={view}
                onValueChange={(next) => {
                  setView(next);
                  if (next !== "query" && table()) void run(next);
                  else {
                    controller?.abort();
                    setRows(undefined);
                    setColumns([]);
                  }
                }}
                ariaLabel={a().view}
                options={[
                  { value: "query", label: a().sql },
                  { value: "data", label: a().table },
                  { value: "schema", label: a().schema },
                ]}
              />
              <Dropdown.Root
                items={(tables() ?? []).map((item) => ({
                  label: item.name,
                  action: () => {
                    setTable(item.name);
                    const url = new URL(location.href);
                    url.searchParams.set("table", item.name);
                    history.replaceState(null, "", url);
                    if (view() === "query") draft(`SELECT * FROM "${item.name.replaceAll('"', '""')}" LIMIT 100`);
                    else void run(view(), item.name);
                  },
                }))}
              >
                <Dropdown.Trigger variant="secondary" label={a().table} disabled={tables.loading}>
                  {table() || a().table}
                </Dropdown.Trigger>
              </Dropdown.Root>
              <Button size="sm" variant="ghost" onClick={() => void reloadTables()}>
                <i class="ti ti-refresh" />
                {t().refresh}
              </Button>
            </div>
            <Show when={tables.error}>
              <NoticeCard tone="danger" title={String(tables.error)} />
            </Show>
            <div hidden={view() !== "query"} class="assistant-sql-editor">
              <SourceEditor
                path="query.sql"
                language="sql"
                content={text()}
                onChange={draft}
                onSave={() => {}}
                onRun={() => void run("query")}
              />
            </div>
            <div class="assistant-advanced-toolbar">
              <Button disabled={busy() || (view() !== "query" && !table())} onClick={() => void run()}>
                <i class="ti ti-player-play" />
                {t().start}
              </Button>
              <Button variant="ghost" disabled={!busy()} onClick={() => controller?.abort()}>
                {t().stop}
              </Button>
              <Button
                variant="ghost"
                disabled={!rows()?.length}
                onClick={() =>
                  files.downloadFileFromContent(
                    "\uFEFF" +
                      Papa.unparse(
                        { fields: columns(), data: rows()!.map((row) => columns().map((key) => cell(row[key]))) },
                        { delimiter: ";", newline: "\r\n", escapeFormulae: true },
                      ),
                    "query-results.csv",
                    "text/csv;charset=utf-8",
                  )
                }
              >
                <i class="ti ti-download" />
                CSV
              </Button>
              <Show when={rows()}>
                <small>
                  {rows()!.length} {a().rows} · {elapsed().toFixed(0)} ms
                </small>
              </Show>
            </div>
            <Show when={rows()?.length === (view() === "data" ? 100 : 1000)}>
              <NoticeCard tone="info" title={a().moreRows} />
            </Show>
            <div class="assistant-sql-results">
              <Show when={!busy()} fallback={<Placeholder state="loading" title={t().loading} />}>
                <Show when={rows()} fallback={<Placeholder title={a().noResults} />}>
                  <DataTable
                    surface="paper"
                    rows={rows() ?? []}
                    columns={columns().map((key) => ({ id: key, header: key, value: (row: Record<string, unknown>) => cell(row[key]) }))}
                    empty={a().empty}
                  />
                </Show>
              </Show>
            </div>
          </Show>
        </Show>
      </Show>
      <Show when={error()}>
        <NoticeCard tone="danger" title={error()} />
      </Show>
    </div>
  );
}
