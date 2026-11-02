import { appAccentStyle } from "@k2b/cloud/ssr/app-appearance";
import { Button, DataTable, type DataTableColumn, FilterToggle, Placeholder, StatusBadge, TextInput, useLocale } from "@k2b/ui";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { type AppStatusKind, type AppsListState, appsHref, matchesSearch } from "./model";
import { type AppsPageMessages, appsPageMessages } from "./page-messages";

/** One app as the list shows it; the server words the problem, so list and detail say the same. */
export type AppsTableRow = {
  id: string;
  name: string;
  icon: string;
  accent: string | null;
  status: AppStatusKind;
  release: string | null;
  /** "/mail, /api/mail +2", or the reason the app has none. */
  routes: string;
  /** The most important hint in one line, with "+n" for more. */
  problem: string | null;
  problemTone: "neutral" | "warning" | "danger" | null;
  /** Not running cleanly or something to do; such rows stay under "Problems". */
  problematic: boolean;
};

const STATUS_TONE: Record<AppStatusKind, "ok" | "warning" | "error" | "neutral"> = {
  ok: "ok",
  warn: "warning",
  error: "error",
  idle: "neutral",
};
const STATUSES: AppStatusKind[] = ["ok", "warn", "error", "idle"];
const statusLabel = (t: AppsPageMessages, status: AppStatusKind) =>
  ({ ok: t.statusOk, warn: t.statusWarn, error: t.statusError, idle: t.statusIdle })[status];
const PROBLEM_TONE = { neutral: "text-(--k2b-text-muted)", warning: "text-(--k2b-warning-text)", danger: "text-(--k2b-danger-text)" };

/** True when focus sits in a field or a dialog is open: Escape belongs to them, not to the detail. */
const escapeTaken = (event: KeyboardEvent) =>
  event.defaultPrevented ||
  [...document.querySelectorAll<HTMLElement>("dialog[open], [role='dialog'], [role='alertdialog'], [role='menu']")].some((element) =>
    element.checkVisibility(),
  ) ||
  (event.target instanceof HTMLElement && Boolean(event.target.closest("input, textarea, select, [contenteditable='true']")));

/**
 * The app list: search, the "Problems" filter and one row per app. A row opens the app's detail beside it; search and
 * filter stay in the URL, so the open app, reload and back keep the same rows. With an app open the table keeps only
 * name, state and problem.
 */
export default function AppsTable(props: { rows: readonly AppsTableRow[]; selected: string | null; list: AppsListState }) {
  const locale = useLocale();
  const t = () => appsPageMessages.resolve([locale()]).t;
  const [q, setQ] = createSignal(props.list.q);
  const [problems, setProblems] = createSignal(props.list.problems);
  const list = (): AppsListState => ({ q: q().trim(), problems: problems() });
  const shown = createMemo(() => props.rows.filter((row) => (!problems() || row.problematic) && matchesSearch(row, q(), locale())));
  const problemCount = () => props.rows.filter((row) => row.problematic).length;
  const href = (app: string | null) => appsHref({ app, list: list() });
  // The address follows the list at once, so reload, a copied link and back show the same rows.
  const remember = () => {
    const url = new URL(location.href);
    url.searchParams.delete("q");
    url.searchParams.delete("filter");
    if (list().q) url.searchParams.set("q", list().q);
    if (list().problems) url.searchParams.set("filter", "problems");
    history.replaceState(history.state, "", `${url.pathname}${url.search}`);
  };
  const reset = () => {
    setQ("");
    setProblems(false);
    remember();
  };
  onMount(() => {
    // Escape closes the detail beside the list, as the close button does.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !props.selected || escapeTaken(event)) return;
      location.assign(href(null));
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });
  // Beside an open app only name, state and problem stay; on a phone, name and state.
  const columns = (): DataTableColumn<AppsTableRow>[] => {
    const wide = props.selected ? "" : "hidden md:table-cell";
    const all: DataTableColumn<AppsTableRow>[] = [
      { id: "app", header: t().columnApp, value: "name" },
      { id: "status", header: t().columnStatus, value: "status", nowrap: true, class: "w-36 min-w-36" },
      { id: "version", header: t().columnVersion, value: "release", align: "right", nowrap: true, class: `w-24 ${wide}` },
      { id: "address", header: t().columnAddress, value: "routes", class: wide },
      { id: "problem", header: t().columnProblem, value: "problem", class: wide },
    ];
    return props.selected ? all.filter((column) => column.id !== "version" && column.id !== "address") : all;
  };
  return (
    <div class="flex min-h-0 flex-col gap-3" data-apps-list>
      <div class="flex flex-wrap items-center gap-2">
        <TextInput
          class="w-full md:w-72"
          type="search"
          icon="ti ti-search"
          aria-label={t().search}
          placeholder={t().search}
          value={q()}
          onValueChange={(value) => {
            setQ(value);
            remember();
          }}
          clearable
          maxLength={80}
        />
        <FilterToggle
          icon="ti ti-alert-triangle"
          label={t().problems({ count: problemCount() })}
          active={problems()}
          href={appsHref({ app: props.selected, list: { q: list().q, problems: !problems() } })}
          onClick={(event) => {
            event.preventDefault();
            setProblems(!problems());
            remember();
          }}
        />
      </div>
      <DataTable
        ariaLabel={t().apps}
        rows={shown()}
        columns={columns()}
        getRowId={(row) => row.id}
        selectedRowId={props.selected}
        onRowClick={(row) => location.assign(href(row.id))}
        highlightColumns={false}
        stickyHeader={false}
        surface="plain"
        scrollPreserveKey={false}
        empty={
          <Placeholder
            state="no-results"
            description={t().noMatch}
            action={
              <Button size="sm" variant="secondary" onClick={reset}>
                {t().showAllApps}
              </Button>
            }
          />
        }
        renderCell={({ row, col }) => {
          if (col.id === "app")
            return (
              <a
                href={href(row.id)}
                class="flex min-w-0 items-center gap-2.5 py-1"
                aria-current={row.id === props.selected ? "true" : undefined}
                data-app={row.id}
              >
                <span
                  class="app-accent-scope k2b-icon-tile app-accent-text flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
                  style={appAccentStyle(row.accent ?? undefined)}
                  aria-hidden="true"
                >
                  <i class={row.icon || "ti ti-apps"} />
                </span>
                <span class="flex min-w-0 flex-col">
                  <span class="truncate font-medium">{row.name}</span>
                  {/* On a phone the table keeps name and state; the problem, or else the address, moves under the name. */}
                  <span class={`truncate text-xs md:hidden ${row.problem ? PROBLEM_TONE[row.problemTone ?? "neutral"] : "text-dimmed"}`}>
                    {row.problem ?? row.routes}
                  </span>
                </span>
              </a>
            );
          if (col.id === "status")
            return (
              <StatusBadge
                variant="dot"
                tone={STATUS_TONE[row.status]}
                label={statusLabel(t(), row.status)}
                labels={STATUSES.map((status) => statusLabel(t(), status))}
              />
            );
          if (col.id === "version") return <span class="tabular-nums">{row.release ?? "–"}</span>;
          if (col.id === "address") return <span class="truncate text-dimmed">{row.routes}</span>;
          return (
            <Show when={row.problem} fallback={<span class="text-dimmed">–</span>}>
              {(problem) => (
                <span class={`truncate ${PROBLEM_TONE[row.problemTone ?? "neutral"]}`} title={problem()}>
                  {problem()}
                </span>
              )}
            </Show>
          );
        }}
      />
    </div>
  );
}
