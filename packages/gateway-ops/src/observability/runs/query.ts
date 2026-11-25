/**
 * The runs list's one declaration: jobs, workflow runs, deliveries and dead letters, filtered by kind, status, app and
 * time. The SSR page reads the address only through it; each kind's own reader filters (`service.ts`). The kinds come
 * from different stores, so each kind pages on its own: there is no sort across kinds.
 */
import { defineListQuery, field, type ListQueryIssue, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import { type RunsMessages, runsMessages } from "./messages";

export const RUNS_PATH = "/admin/observability/runs";

export const RUN_KINDS = ["job", "workflow", "delivery", "deadLetter"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/** One status word for every kind; `service.ts` maps it to each store's own states. */
export const RUN_STATUSES = ["failed", "running", "waiting", "succeeded", "canceled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** The windows the job runs store answers (`TraceWindow`); workflows and deliveries take their start. */
export const RUN_WINDOWS = {
  "last-10m": "10m",
  "last-1h": "1h",
  "last-12h": "12h",
  "last-24h": "24h",
  "last-7d": "7d",
  "last-30d": "30d",
} as const;
export type RunWindowPreset = keyof typeof RUN_WINDOWS;
export const RUN_WINDOW_HOURS: Record<RunWindowPreset, number> = {
  "last-10m": 1 / 6,
  "last-1h": 1,
  "last-12h": 12,
  "last-24h": 24,
  "last-7d": 168,
  "last-30d": 720,
};

export const JOB_CATEGORIES = ["job", "schedule", "backfill", "ai", "http", "notification", "sync", "custom"] as const;
export const JOB_MIN_DURATIONS = ["20", "100", "1000", "10000"] as const;

/** Rows per page when one kind is shown; with several kinds, each shows its newest `RUNS_PREVIEW`. */
export const RUNS_PER_PAGE = 100;
export const RUNS_PREVIEW = 20;
export const RUNS_PAGE_MAX = 1000;
export const RUNS_SEARCH_MAX = 200;

const windowLabel = (t: RunsMessages, preset: RunWindowPreset): string =>
  ({
    "last-10m": t.last10m,
    "last-1h": t.last1h,
    "last-12h": t.last12h,
    "last-24h": t.last24h,
    "last-7d": t.last7d,
    "last-30d": t.last30d,
  })[preset];

/** Apps the address can hold: the known ones, and the one it names. */
const appOptions = (apps: readonly { id: string; label: string }[], selected?: string) => {
  const known = apps.filter((app) => app.id !== "" && !app.id.includes(","));
  const extra = selected && !selected.includes(",") && !known.some((app) => app.id === selected) ? [{ id: selected, label: selected }] : [];
  return [...known, ...extra].map((app) => ({ value: app.id, label: app.label }));
};

/** Builds the declaration in the request's language with the apps the person can filter by. */
export const runsQuery = (locale: string, apps: readonly { id: string; label: string }[] = [], selectedApp?: string) => {
  const { t } = runsMessages.resolve([locale]);
  return defineListQuery({
    key: "gateway-ops.runs",
    fields: {
      kind: field.choice({
        label: t.kind,
        common: true,
        options: [
          { value: "job", label: t.jobs },
          { value: "workflow", label: t.workflows },
          { value: "delivery", label: t.deliveries },
          { value: "deadLetter", label: t.deadLetters },
        ],
      }),
      status: field.choice({
        label: t.status,
        common: true,
        multiple: false,
        options: [
          { value: "failed", label: t.failed },
          { value: "running", label: t.running },
          { value: "waiting", label: t.waiting },
          { value: "succeeded", label: t.succeeded },
          { value: "canceled", label: t.canceled },
        ],
      }),
      app: field.choice({ label: t.app, common: true, multiple: false, options: appOptions(apps, selectedApp) }),
      time: field.timeRange({
        label: t.time,
        common: true,
        custom: false,
        presets: (Object.keys(RUN_WINDOWS) as RunWindowPreset[]).map((value) => ({ value, label: windowLabel(t, value) })),
        required: { kind: "preset", preset: "last-24h" },
      }),
      // Filters of one kind, as before: they apply to jobs or deliveries only.
      category: field.choice({
        label: t.jobType,
        multiple: false,
        options: JOB_CATEGORIES.map((value) => ({ value, label: t.categoryLabel({ value }) })),
      }),
      duration: field.choice({
        label: t.minDuration,
        multiple: false,
        options: JOB_MIN_DURATIONS.map((value) => ({ value, label: t.atLeast({ ms: Number(value) }) })),
      }),
      source: field.text({ label: t.jobSource }),
      channel: field.text({ label: t.channel }),
    },
    search: { label: t.search },
    sort: { fixed: { field: "started", direction: "desc", label: t.newestFirst } },
    pageParams: ["page", "run", "tab"],
  });
};

export type RunsQuery = ReturnType<typeof runsQuery>;
export type RunsState = ListQueryStateOf<RunsQuery>;

/** The kinds a state shows: the chosen ones, or all. */
export const kindsOf = (state: RunsState): readonly RunKind[] => (state.filters.kind?.length ? state.filters.kind : RUN_KINDS);

/** The open record: its kind and the kind's own key, such as `job:<traceId>:<spanId>` or `delivery:<uuid>`. */
export type RunRef = { kind: RunKind; id: string };
const RUN_REF = /^(job|workflow|delivery|deadLetter):([^\s]{1,300})$/;
export const parseRunRef = (raw: string | null): RunRef | null => {
  const match = raw ? RUN_REF.exec(raw) : null;
  return match ? { kind: match[1] as RunKind, id: match[2]! } : null;
};
export const runRefText = (ref: RunRef) => `${ref.kind}:${ref.id}`;

export type RunsAddress = {
  state: RunsState;
  page: number;
  run: RunRef | null;
  tab: "runs" | "schedules";
  issues: readonly ListQueryIssue[];
};

/** Reads an address with the declaration and holds it to the list's bounds. Never throws. */
export const parseRunsAddress = (query: RunsQuery, params: URLSearchParams): RunsAddress => {
  const parsed = query.parse(params);
  const issues: ListQueryIssue[] = [...parsed.issues];
  let state = parsed.state;
  if (state.search && state.search.length > RUNS_SEARCH_MAX) {
    issues.push({ code: "invalid", param: "q", value: state.search });
    state = { ...state, search: undefined };
  }
  const pageRaw = params.get("page");
  const page = pageRaw === null ? 1 : Number(pageRaw);
  return {
    state,
    page: Number.isSafeInteger(page) && page >= 1 && page <= RUNS_PAGE_MAX ? page : 1,
    run: parseRunRef(params.get("run")),
    tab: params.get("tab") === "schedules" ? "schedules" : "runs",
    issues,
  };
};

/** The address of a state plus the page parameters the list keeps. */
export const runsHref = (query: RunsQuery, state: RunsState, extra: { page?: number; run?: RunRef | null; tab?: "schedules" } = {}) => {
  const params = query.serialize(state);
  if (extra.page && extra.page > 1) params.set("page", String(extra.page));
  if (extra.run) params.set("run", runRefText(extra.run));
  if (extra.tab) params.set("tab", extra.tab);
  const text = params.toString();
  return text ? `${RUNS_PATH}?${text}` : RUNS_PATH;
};
