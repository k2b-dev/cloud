import { files } from "@k2b/stdlib/browser";
import { Button, DataTable, NoticeCard, Placeholder, Tabs, useLocale } from "@k2b/ui";
import Papa from "papaparse";
import { createResource, createSignal, onCleanup, onMount, Show } from "solid-js";
import { z } from "zod";
import { advancedMessages } from "./advanced-messages";
import { artifactClient } from "./client";
import { artifactMessages } from "./messages";
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
  initialStatus: Awaited<ReturnType<typeof artifactClient.databaseStatus>>;
}) {
  const locale = useLocale(),
    t = () => artifactMessages.resolve([locale()]).t,
    a = () => advancedMessages.resolve([locale()]).t;
  const [status, { refetch }] = createResource(() => artifactClient.databaseStatus(props.id), { initialValue: props.initialStatus });
  const [text, setText] = createSignal("SELECT 1 AS example");
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
  async function run(mode = view()) {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    setBusy(true);
    setError("");
    setRows(undefined);
    setColumns([]);
    const began = performance.now();
    try {
      let data: Record<string, unknown>[];
      if (mode === "schema") {
        const tables = z
          .array(z.object({ name: z.string() }))
          .parse(await artifactClient.databaseInspect(props.id, { operation: "tables.list" }, current.signal));
        data = [];
        for (const table of tables) {
          current.signal.throwIfAborted();
          const schema = z
            .object({ columns: z.array(z.record(z.string(), z.unknown())) })
            .parse(await artifactClient.databaseInspect(props.id, { operation: "schema.get", table: table.name }, current.signal));
          data.push(...schema.columns.map((column) => ({ [a().table]: table.name, ...column })));
        }
      } else {
        data = Rows.parse(
          await artifactClient.databaseInspect(props.id, { operation: "query", sql: text(), params: [] }, current.signal),
        ).data;
      }
      if (current !== controller) return;
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
      <Show when={view() === "query"}>
        <p class="assistant-sql-hint">{a().queryHelp}</p>
      </Show>
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
                variant="pill"
                value={view}
                onValueChange={(next) => {
                  setView(next);
                  if (next === "schema") void run(next);
                  else {
                    controller?.abort();
                    controller = undefined;
                    setBusy(false);
                    setError("");
                    setRows(undefined);
                    setColumns([]);
                  }
                }}
                ariaLabel={a().view}
                options={[
                  { value: "query", label: "SQL" },
                  { value: "schema", label: a().schema },
                ]}
              />
            </div>
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
              <Button size="sm" loading={busy()} disabled={busy()} onClick={() => void run()}>
                <i class={view() === "query" ? "ti ti-player-play" : "ti ti-refresh"} />
                {view() === "query" ? t().start : t().refresh}
              </Button>
              <Show when={busy()}>
                <Button size="sm" variant="ghost" onClick={() => controller?.abort()}>
                  {t().stop}
                </Button>
              </Show>
              <Show when={view() === "query"}>
                <Button
                  size="sm"
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
              </Show>
              <Show when={rows()}>
                <small>
                  {rows()!.length} {a().rows} · {elapsed().toFixed(0)} ms
                </small>
              </Show>
            </div>
            <Show when={view() === "query" && rows()?.length === 1000}>
              <NoticeCard tone="info" title={a().moreRows} />
            </Show>
            <div class="assistant-sql-results">
              <Show when={!busy()} fallback={<Placeholder state="loading" title={t().loading} />}>
                <Show
                  when={rows()}
                  fallback={
                    <Show when={view() === "query"}>
                      <Placeholder title={a().noResults} />
                    </Show>
                  }
                >
                  <Show when={view() !== "schema" || rows()?.length} fallback={<Placeholder title={a().noTables} />}>
                    <DataTable
                      surface="paper"
                      rows={rows() ?? []}
                      columns={columns().map((key) => ({ id: key, header: key, value: (row: Record<string, unknown>) => cell(row[key]) }))}
                      empty={a().empty}
                    />
                  </Show>
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
