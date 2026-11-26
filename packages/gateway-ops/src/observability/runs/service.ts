/**
 * The runs list's readers: each kind asks its own store with the filters it understands, and the rows meet in one shape.
 * Kinds never sort or page together; each pages on its own (`RUNS_PER_PAGE` alone, `RUNS_PREVIEW` beside others).
 */
import { notifications, type TraceEvent, type TraceListFilter, type TraceSpan, trace } from "@k2b/cloud/services";
import type { WorkflowRunState } from "@k2b/cloud/workflows";
import { getWorkflow, getWorkflowRun, listWorkflowFamilies, listWorkflowRuns, type WorkflowRunSummary } from "@k2b/cloud/workflows/store";
import type { LookupItem } from "@k2b/ui/v2/list-query";
import { syncOpsService } from "../sync/runtime";
import type { SyncDeadLetterRow, SyncOpsCredentials } from "../sync/service";
import { RUN_WINDOW_HOURS, RUN_WINDOWS, type RunKind, type RunRef, type RunStatus, type RunsState } from "./query";

/** One run of any kind, in the list's shape. `ref` opens its record. */
export type RunRow = {
  ref: RunRef;
  appId: string | null;
  /** What ran: the job, the workflow, the notification, the store. */
  name: string;
  /** The second line: source, recipient and channel, reason. */
  detail: string;
  status: RunStatus;
  /** The store's own word for the state, when it says more than the common one ("needs_attention", "deferred"). */
  state: string;
  /** ISO time the run started, or the dead letter failed. */
  at: string;
  durationMs: number | null;
  /** The kind's record outside this list (workflow run, dead letter); absent when the list opens the record itself. */
  recordHref?: string;
};

/** One kind's part of the list: its rows, how many there are when the store counts, and whether more follow. */
export type RunsPart = {
  kind: RunKind;
  rows: RunRow[];
  /** Exact count when the store counts; null when it only knows that more follow. */
  total: number | null;
  more: boolean;
  /** The store did not answer; the other kinds still show. */
  error: string | null;
};

type Paging = { offset: number; limit: number };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ── Jobs (trace spans) ───────────────────────────────────────────────────────────────────────────────────────────

const jobStatus = (span: TraceSpan): RunStatus => (!span.endedAt ? "running" : span.status === "error" ? "failed" : "succeeded");

/** A job filter for a state, or null when no job can match (a status jobs do not have). */
const jobFilter = (state: RunsState): TraceListFilter | null => {
  const status = state.filters.status;
  if (status === "waiting" || status === "canceled" || workflowOnly(state)) return null;
  const time = state.filters.time;
  return {
    window: time.kind === "preset" ? RUN_WINDOWS[time.preset] : "24h",
    ...(state.filters.app ? { appId: state.filters.app } : {}),
    ...(status === "failed" ? { status: "error" as const } : status === "succeeded" ? { status: "ok" as const } : {}),
    ...(status === "running" ? { active: true } : {}),
    ...(state.search ? { search: state.search } : {}),
    ...(state.filters.category ? { category: state.filters.category } : {}),
    ...(state.filters.duration ? { minDurationMs: Number(state.filters.duration) } : {}),
    ...(state.filters.source ? { source: state.filters.source } : {}),
  };
};

const jobs = async (state: RunsState, paging: Paging): Promise<RunsPart> => {
  const filter = jobFilter(state);
  if (!filter) return { kind: "job", rows: [], total: 0, more: false, error: null };
  const { spans, total } = await trace.list(
    { page: Math.floor(paging.offset / paging.limit) + 1, perPage: paging.limit, offset: paging.offset },
    { filter },
  );
  return {
    kind: "job",
    rows: spans.map((span) => ({
      ref: { kind: "job", id: `${span.traceId}:${span.spanId}` },
      appId: span.appId ?? null,
      name: span.name,
      detail: span.source,
      status: jobStatus(span),
      state: span.endedAt ? span.status : "running",
      at: span.startedAt,
      durationMs: span.durationMs ?? null,
    })),
    total,
    more: paging.offset + spans.length < total,
    error: null,
  };
};

// ── Workflow runs ────────────────────────────────────────────────────────────────────────────────────────────────

const WORKFLOW_STATE: Record<RunStatus, WorkflowRunState> = {
  failed: "failed",
  running: "running",
  waiting: "waiting",
  succeeded: "succeeded",
  canceled: "canceled",
};

/** A workflow run's error is JSON: its message when it has one, else its text. */
const words = (value: unknown): string | null => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "message" in value && typeof value.message === "string") return value.message;
  return JSON.stringify(value);
};

const workflowStatus = (state: WorkflowRunState): RunStatus =>
  state === "failed" || state === "needs_attention"
    ? "failed"
    : state === "running"
      ? "running"
      : state === "queued" || state === "waiting"
        ? "waiting"
        : state === "canceled"
          ? "canceled"
          : "succeeded";

const sinceOf = (state: RunsState, now: Date) => {
  const time = state.filters.time;
  return new Date(now.getTime() - (time.kind === "preset" ? RUN_WINDOW_HOURS[time.preset] : 24) * 3_600_000);
};

/** Workflow runs have no search and no per-kind filters: with those set, no workflow run can match. */
const workflowsMatch = (state: RunsState) =>
  !state.search && !state.filters.category && !state.filters.duration && !state.filters.source && !state.filters.channel;

const workflows = async (state: RunsState, paging: Paging, now: Date): Promise<RunsPart> => {
  if (!workflowsMatch(state)) return { kind: "workflow", rows: [], total: 0, more: false, error: null };
  const status = state.filters.status;
  // The store counts nothing: one more row than shown says whether more follow.
  const runs: WorkflowRunSummary[] = await listWorkflowRuns({
    ...(state.filters.app ? { appId: state.filters.app } : {}),
    ...(status ? { state: WORKFLOW_STATE[status] } : {}),
    ...(state.filters.workflow ? { workflowId: state.filters.workflow } : {}),
    ...(state.filters.parent ? { parentRunId: state.filters.parent } : {}),
    since: sinceOf(state, now),
    limit: paging.limit + 1,
    offset: paging.offset,
  });
  const shown = runs.slice(0, paging.limit);
  return {
    kind: "workflow",
    rows: shown.map((run) => ({
      ref: { kind: "workflow", id: run.id },
      appId: run.appId,
      name: run.workflowName,
      detail: words(run.error) ?? run.resultMessage ?? run.eventType ?? "",
      status: workflowStatus(run.state),
      state: run.state,
      at: (run.startedAt ?? run.createdAt).toString(),
      durationMs: run.durationMs ?? null,
      recordHref: `/admin/observability/workflows?run=${encodeURIComponent(run.id)}`,
    })),
    total: null,
    more: runs.length > paging.limit,
    error: null,
  };
};

// ── Deliveries ───────────────────────────────────────────────────────────────────────────────────────────────────

type DeliveryStatus = Awaited<ReturnType<typeof notifications.observability.deliveries.list>>["items"][number]["status"];
const DELIVERY_STATUSES: Record<RunStatus, DeliveryStatus[]> = {
  failed: ["failed"],
  running: ["sending"],
  waiting: ["pending", "deferred"],
  succeeded: ["delivered"],
  canceled: ["suppressed"],
};

const deliveryStatus = (status: DeliveryStatus): RunStatus =>
  (Object.keys(DELIVERY_STATUSES) as RunStatus[]).find((key) => DELIVERY_STATUSES[key].includes(status)) ?? "waiting";

/** Filters that name one workflow definition or one parent run: only workflow runs can match them. */
const workflowOnly = (state: RunsState) => Boolean(state.filters.workflow || state.filters.parent);

/** Deliveries have no job or workflow filters: with those set, no delivery can match. */
const deliveriesMatch = (state: RunsState) =>
  !state.filters.category && !state.filters.duration && !state.filters.source && !workflowOnly(state);

const deliveries = async (state: RunsState, paging: Paging, now: Date): Promise<RunsPart> => {
  if (!deliveriesMatch(state)) return { kind: "delivery", rows: [], total: 0, more: false, error: null };
  const status = state.filters.status;
  const result = await notifications.observability.deliveries.list({
    page: Math.floor(paging.offset / paging.limit) + 1,
    perPage: paging.limit,
    filter: {
      since: sinceOf(state, now),
      ...(status ? { statuses: DELIVERY_STATUSES[status] } : {}),
      ...(state.filters.app ? { appIds: [state.filters.app] } : {}),
      ...(state.filters.channel ? { channels: [state.filters.channel] } : {}),
      ...(state.search ? { search: state.search } : {}),
    },
  });
  return {
    kind: "delivery",
    rows: result.items.map((item) => ({
      ref: { kind: "delivery", id: item.id },
      appId: item.appId,
      name: item.title || item.label,
      detail: [item.recipientLabel, item.channel].filter(Boolean).join(" · "),
      status: deliveryStatus(item.status),
      state: item.status,
      at: new Date(item.createdAt).toISOString(),
      durationMs: item.deliveredAt ? new Date(item.deliveredAt).getTime() - new Date(item.createdAt).getTime() : null,
    })),
    total: result.total,
    more: paging.offset + result.items.length < result.total,
    error: null,
  };
};

// ── Dead letters ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A dead letter's record: the Sync page with its store and message open. */
export const deadLetterHref = (row: Pick<SyncDeadLetterRow, "appId" | "kind" | "store" | "messageId" | "streamSequence">) => {
  const params = new URLSearchParams({ storeApp: row.appId, kind: row.kind, store: row.store, message: row.messageId });
  if (row.streamSequence) params.set("sequence", String(row.streamSequence));
  return `/admin/observability/nats/sync?${params}`;
};

/**
 * Dead letters wait until someone handles them, so the time range does not apply. The Sync service reads every app's
 * stores (each store's page is bounded by its app) and has no paging: this list pages the bounded result itself.
 */
const deadLetters = async (state: RunsState, paging: Paging, credentials: SyncOpsCredentials): Promise<RunsPart> => {
  const status = state.filters.status;
  if (
    (status && status !== "failed") ||
    state.filters.category ||
    state.filters.duration ||
    state.filters.source ||
    state.filters.channel ||
    workflowOnly(state)
  ) {
    return { kind: "deadLetter", rows: [], total: 0, more: false, error: null };
  }
  const overview = await syncOpsService.overview(credentials, { app: state.filters.app });
  const needle = state.search?.toLowerCase();
  const all = overview.deadLetters
    .filter(
      (row) =>
        !needle || [row.store, row.reason, row.error ?? "", row.messageId, row.appId].some((text) => text.toLowerCase().includes(needle)),
    )
    .sort((left, right) => right.failedAt.localeCompare(left.failedAt));
  const shown = all.slice(paging.offset, paging.offset + paging.limit);
  return {
    kind: "deadLetter",
    rows: shown.map((row) => ({
      ref: { kind: "deadLetter", id: `${row.appId}/${row.kind}/${row.store}/${row.messageId}` },
      appId: row.appId,
      name: row.store,
      detail: row.error ? `${row.reason} — ${row.error}` : row.reason,
      status: "failed" as const,
      state: row.kind,
      at: row.failedAt,
      durationMs: null,
      recordHref: deadLetterHref(row),
    })),
    // Cut stores ("+") are counted as what was read.
    total: overview.truncatedStores.length > 0 ? null : all.length,
    more: paging.offset + paging.limit < all.length || overview.truncatedStores.length > 0,
    error: null,
  };
};

// ── The list ─────────────────────────────────────────────────────────────────────────────────────────────────────

const read = async (kind: RunKind, run: () => Promise<RunsPart>): Promise<RunsPart> =>
  run().catch((error: unknown) => ({ kind, rows: [], total: null, more: false, error: message(error) }));

/**
 * The parts of the list for a state: one kind pages through `perPage` rows, several kinds show their newest `preview`.
 * A kind whose store fails reports it in its part; the others still answer.
 */
export const listRuns = async (
  state: RunsState,
  kinds: readonly RunKind[],
  options: { page: number; perPage: number; preview: number; credentials: SyncOpsCredentials; now?: Date },
): Promise<RunsPart[]> => {
  const now = options.now ?? new Date();
  const paging: Paging =
    kinds.length === 1 ? { offset: (options.page - 1) * options.perPage, limit: options.perPage } : { offset: 0, limit: options.preview };
  const readers: Record<RunKind, () => Promise<RunsPart>> = {
    job: () => jobs(state, paging),
    workflow: () => workflows(state, paging, now),
    delivery: () => deliveries(state, paging, now),
    deadLetter: () => deadLetters(state, paging, options.credentials),
  };
  return Promise.all(kinds.map((kind) => read(kind, readers[kind])));
};

// ── Records ──────────────────────────────────────────────────────────────────────────────────────────────────────

type DeliveryItem = Awaited<ReturnType<typeof notifications.observability.deliveries.list>>["items"][number];

/** The record a row opens in this list: a job run with its events, or a delivery. Workflow runs and dead letters open their own pages. */
export type RunRecord = { kind: "job"; span: TraceSpan; events: TraceEvent[] } | { kind: "delivery"; item: DeliveryItem };

const JOB_ID = /^([0-9a-f]{32}):([0-9a-f]{16})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads the open record; `null` when it is gone or the reference names nothing this list opens. */
export const readRunRecord = async (ref: RunRef): Promise<RunRecord | null> => {
  if (ref.kind === "job") {
    const match = JOB_ID.exec(ref.id);
    if (!match) return null;
    const [span, events] = await Promise.all([
      trace.getSpan({ traceId: match[1]!, spanId: match[2]! }),
      trace.events({ traceId: match[1]!, spanId: match[2]!, limit: 200 }),
    ]);
    return span ? { kind: "job", span, events } : null;
  }
  if (ref.kind === "delivery") {
    if (!UUID.test(ref.id)) return null;
    const result = await notifications.observability.deliveries.list({ page: 1, perPage: 1, filter: { id: ref.id } });
    const item = result.items[0];
    return item ? { kind: "delivery", item } : null;
  }
  return null;
};

// ── Names of chosen workflow filters ─────────────────────────────────────────────────────────────────────────────

/**
 * The names of the workflow definition and the parent run the address names, for the first picture of the filter bar.
 * One read each, only while that filter is set; never one per row.
 */
export const workflowFilterNames = async (state: RunsState): Promise<{ workflow?: LookupItem[]; parent?: LookupItem[] }> => {
  const [definition, parent] = await Promise.all([
    state.filters.workflow ? getWorkflow(state.filters.workflow).catch(() => null) : null,
    state.filters.parent ? getWorkflowRun(state.filters.parent).catch(() => null) : null,
  ]);
  return {
    ...(definition ? { workflow: [{ value: definition.id, label: definition.name, meta: definition.appId }] } : {}),
    ...(parent ? { parent: [{ value: parent.id, label: parent.workflowName, meta: parent.appId }] } : {}),
  };
};

/** Workflow definitions that ran in the window, for the workflow filter's search: names that contain the text. */
export const searchWorkflowDefinitions = async (
  text: string,
  options: { appId?: string; since: Date; limit: number },
): Promise<LookupItem[]> => {
  const needle = text.trim().toLowerCase();
  const families = await listWorkflowFamilies({ ...(options.appId ? { appId: options.appId } : {}), since: options.since });
  return families
    .filter((family) => !needle || family.workflowName.toLowerCase().includes(needle))
    .slice(0, options.limit)
    .map((family) => ({ value: family.workflowId, label: family.workflowName, meta: family.appId }));
};
