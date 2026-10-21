import type { AssistantLaunch } from "@k2b/cloud/ai/browser";
import { useLocale } from "@k2b/ui";
import { type Accessor, createSignal, onCleanup, onMount } from "solid-js";
import { isServer } from "solid-js/web";
import { pulseMessages } from "../../messages";
import { SQL_MAX_BYTES, SQL_MAX_PARAMETERS, SqlInputError, sqlParameterNames, validateSqlInput } from "../../sql-params";
import { baseStoreMessages } from "./base-store-messages";
import { launchPulseSqlAssistant, type PulseAssistantLaunchInput } from "./pulse-assistant-launch";
import type { WorkspaceRouteState } from "./routes";
import {
  createSqlRunId,
  type SavedQuery,
  type SqlClient,
  SqlClientError,
  type SqlErrorDetails,
  type SqlLimits,
  type SqlParams,
  type SqlResult,
  sqlClient,
} from "./sql-client";

export type SqlConsoleError = { code: string; message?: string; details: SqlErrorDetails; cause?: unknown };
export type SqlRunState =
  | { kind: "empty" | "ready" }
  | { kind: "running"; runId: string }
  | { kind: "ok" }
  | ({ kind: "error" } & SqlConsoleError);
export type SqlStatusBand = {
  kind: "neutral" | "running" | "ok" | "warning" | "error";
  message: string;
  /** Short status heading; an optional diagnosis supplies the full recovery explanation. */
  title?: string;
  diagnosis?: { title: string; message: string; kind?: "error" };
  action?: {
    kind:
      | "retry"
      | "cancel"
      | "focus-parameter"
      | "retry-assistant"
      | "reload-saved"
      | "retry-save"
      | "retry-delete"
      | "retry-limits"
      | "save-as";
    label: string;
    run: () => void | Promise<unknown>;
    parameterName?: string;
  };
};
export type SqlConsoleClock = { now: () => number; schedule: (callback: () => void, delayMs: number) => () => void };
export type SqlConsoleControllerOptions = {
  base: { id: string; name: string };
  initial?: { sql?: string; params?: SqlParams; query?: SavedQuery | null; limits?: SqlLimits | null; error?: SqlConsoleError | null };
  /** In a Solid owner the default is the inherited UI locale. */
  locale?: Accessor<string>;
  client?: SqlClient;
  clock?: SqlConsoleClock;
  newRunId?: () => string;
  newOperationId?: () => string;
  launchAssistant?: (input: PulseAssistantLaunchInput) => Promise<AssistantLaunch>;
  onAssistantLaunched?: (launch: AssistantLaunch) => void;
  onRouteChange?: (state: WorkspaceRouteState) => void;
  focusParameter?: (name: string) => void;
  onSaveAsRequested?: () => void | Promise<void>;
};
export const sqlConsoleInitialState = (
  route: WorkspaceRouteState,
  snapshot?: { query: SavedQuery | null; limits: SqlLimits | null; error: SqlConsoleError | null },
): NonNullable<SqlConsoleControllerOptions["initial"]> => ({
  sql: route.sql ?? snapshot?.query?.sql ?? "",
  params: { ...snapshot?.query?.params, ...route.params },
  query: snapshot?.query ?? null,
  limits: snapshot?.limits ?? null,
  error: snapshot?.error ?? null,
});

const systemClock: SqlConsoleClock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};
const normalizeError = (error: unknown): SqlConsoleError =>
  error instanceof SqlClientError
    ? { code: error.code, message: error.message, details: error.details, cause: error }
    : error instanceof SqlInputError
      ? { code: error.code, message: error.message, details: { line: error.line, column: error.column }, cause: error }
      : { code: "REQUEST_FAILED", details: {}, cause: error };

/** Scanner errors during an incomplete edit never become run errors. Keep any complete prefix. */
export const consoleSqlParameterNames = (sql: string): string[] => {
  try {
    return sqlParameterNames(sql).filter((name) => name !== "base_tz");
  } catch (error) {
    if (!(error instanceof SqlInputError) || !error.line || !error.column) return [];
    const starts = [...sql.matchAll(/\r\n|\r|\n/g)];
    const newline = starts[error.line - 2];
    const offset = (error.line > 1 && newline ? newline.index + newline[0].length : 0) + error.column - 1;
    // Only the parameter-discovery copy ignores parentheses. Their contents and
    // offsets stay intact; the original SQL still goes through strict validation.
    // This also preserves fields inside an unfinished group while typing.
    try {
      return sqlParameterNames(sql.slice(0, offset).replace(/[()]/g, " ")).filter((name) => name !== "base_tz");
    } catch {
      return [];
    }
  }
};

export const createSqlConsoleController = (options: SqlConsoleControllerOptions) => {
  const locale = options.locale ?? useLocale();
  const t = () => pulseMessages.resolve([locale()]).t;
  const client = options.client ?? sqlClient;
  const clock = options.clock ?? systemClock;
  const initial = options.initial;
  const [sql, setText] = createSignal(initial?.sql ?? initial?.query?.sql ?? "");
  const [parameterValues, setValues] = createSignal<SqlParams>({ ...initial?.query?.params, ...initial?.params });
  const [saved, setSaved] = createSignal<SavedQuery | null>(initial?.query ?? null);
  const [limits, setLimits] = createSignal<SqlLimits | null>(initial?.limits ?? null);
  const [state, setState] = createSignal<SqlRunState>({ kind: sql().trim() ? "ready" : "empty" });
  const [lastResult, setResult] = createSignal<SqlResult | null>(null);
  const [quotaResetAt, setQuotaResetAt] = createSignal<string | null>(null);
  const [limitsError, setLimitsError] = createSignal<SqlConsoleError | null>(initial?.error ?? null);
  const [limitsLoading, setLimitsLoading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<SqlConsoleError | null>(null);
  const [saveOperation, setSaveOperation] = createSignal<"save" | "delete">("save");
  const [assistantState, setAssistantState] = createSignal<"idle" | "launching" | "failed">("idle");
  const parameterNames = () => consoleSqlParameterNames(sql());
  const activeParams = (): SqlParams =>
    Object.fromEntries(
      parameterNames()
        .filter((name) => Object.hasOwn(parameterValues(), name))
        .map((name) => [name, parameterValues()[name]!]),
    );
  const equalParams = (a: SqlParams, b: SqlParams) =>
    Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);
  const hasUnsavedChanges = () => {
    const query = saved();
    return query ? query.sql !== sql() || !equalParams(query.params, activeParams()) : !!sql().trim();
  };
  const chosenQuery = () => {
    const query = saved();
    return query
      ? {
          id: query.id,
          name: query.name,
          revision: query.revision,
          dirty: query.sql !== sql() || !equalParams(query.params, activeParams()),
        }
      : null;
  };
  let disposed = false;
  let activeRun: { id: string; abort: AbortController } | null = null;
  const [elapsedSeconds, setElapsedSeconds] = createSignal(0);
  let stopRunTimer: (() => void) | undefined;
  let stopQuotaTimer: (() => void) | undefined;
  const lifetime = new AbortController();
  let limitsVersion = 0;
  let contentVersion = 0;
  let lastSaveName: string | undefined;
  let saveReceipt: { signature: string; key: string } | undefined;
  let deleteReceipt: { queryId: string; revision: number; key: string } | undefined;
  const isStateError = (code: string) => {
    const current = state();
    return current.kind === "error" && current.code === code;
  };
  const quotaBlocked = () => quotaResetAt() !== null;
  const canRun = () => !disposed && !!sql().trim() && state().kind !== "running" && !quotaBlocked();
  const canSave = () => !disposed && !!sql().trim() && !saving() && state().kind !== "running";
  const syncRoute = () =>
    options.onRouteChange?.({ view: "sql", sourceId: "", queryId: saved()?.id ?? "", sql: sql(), params: activeParams() });
  const blockUntil = (resetAt: string | undefined, retryAfter?: number) => {
    const at =
      resetAt && Number.isFinite(Date.parse(resetAt))
        ? Date.parse(resetAt)
        : retryAfter !== undefined
          ? clock.now() + retryAfter * 1000
          : null;
    if (at === null || at <= clock.now()) return;
    stopQuotaTimer?.();
    setQuotaResetAt(new Date(at).toISOString());
    // SSR publishes the block but must not leave a per-request timer behind.
    if (isServer && !options.clock) return;
    stopQuotaTimer = clock.schedule(() => {
      if (disposed) return;
      setQuotaResetAt(null);
      if (isStateError("QUOTA")) setState({ kind: sql().trim() ? "ready" : "empty" });
    }, at - clock.now());
  };
  const acceptLimits = (value: SqlLimits) => {
    setLimits(value);
    setLimitsError(null);
    if (value.queriesUsed >= value.queriesPerHour) blockUntil(value.resetAt);
  };
  if (limits()) acceptLimits(limits()!);
  if (initial?.error?.code === "QUOTA") blockUntil(initial.error.details.resetAt, initial.error.details.retryAfter);
  const refreshLimits = async () => {
    const version = ++limitsVersion;
    setLimitsLoading(true);
    try {
      const value = await client.limits(options.base.id, lifetime.signal);
      if (!disposed && version === limitsVersion) acceptLimits(value);
    } catch (error) {
      if (!disposed && version === limitsVersion) setLimitsError(normalizeError(error));
    } finally {
      if (!disposed && version === limitsVersion) setLimitsLoading(false);
    }
  };
  const edit = () => {
    contentVersion++;
    setResult(null);
    if (!activeRun) setState({ kind: sql().trim() ? "ready" : "empty" });
    syncRoute();
  };
  const setSql = (value: string) => {
    if (disposed) return;
    setText(value);
    edit();
  };
  const setParameter = (name: string, value: string) => {
    if (disposed || name === "base_tz") return;
    setValues((values) => ({ ...values, [name]: value }));
    edit();
  };
  const checkedInput = () => {
    const params = activeParams();
    try {
      validateSqlInput(sql(), params);
      return { sql: sql(), params };
    } catch (error) {
      const normalized = normalizeError(error);
      if (normalized.code === "PARAMETER_MISSING")
        normalized.details.parameterName = parameterNames().find((name) => !Object.hasOwn(params, name));
      setState({ kind: "error", ...normalized });
      return null;
    }
  };
  const run = async () => {
    if (!canRun()) return;
    const input = checkedInput();
    if (!input) return;
    const id = (options.newRunId ?? createSqlRunId)();
    const abort = new AbortController();
    activeRun = { id, abort };
    const editAtRun = contentVersion;
    ++limitsVersion; // An older GET must never replace the newer run's quota snapshot.
    setLimitsLoading(false);
    setState({ kind: "running", runId: id });
    const startedAt = clock.now();
    setElapsedSeconds(0);
    const tick = () => {
      if (disposed || activeRun?.id !== id) return;
      setElapsedSeconds(Math.max(0, Math.floor((clock.now() - startedAt) / 1000)));
      stopRunTimer = clock.schedule(tick, 1000);
    };
    stopRunTimer = clock.schedule(tick, 1000);
    try {
      const result = await client.run(options.base.id, { ...input, runId: id }, abort.signal);
      if (disposed || activeRun?.id !== id) return;
      if (editAtRun === contentVersion) setResult(result);
      ++limitsVersion;
      setLimitsLoading(false);
      acceptLimits(result.limits);
      setState({ kind: editAtRun === contentVersion ? "ok" : sql().trim() ? "ready" : "empty" });
    } catch (error) {
      if (disposed || activeRun?.id !== id) return;
      const failure = normalizeError(error);
      if (failure.code === "QUOTA") {
        blockUntil(failure.details.resetAt, failure.details.retryAfter);
        void refreshLimits();
      }
      setState(editAtRun === contentVersion ? { kind: "error", ...failure } : { kind: sql().trim() ? "ready" : "empty" });
    } finally {
      if (activeRun?.id === id) {
        stopRunTimer?.();
        stopRunTimer = undefined;
        activeRun = null;
      }
    }
  };
  const cancel = async () => {
    const running = activeRun;
    if (!running || disposed) return;
    // Start cancellation with its own signal before aborting the response stream.
    const cancellation = client.cancel(options.base.id, running.id, lifetime.signal);
    activeRun = null;
    stopRunTimer?.();
    stopRunTimer = undefined;
    running.abort.abort();
    setState({ kind: "error", code: "CANCELLED", details: {} });
    try {
      await cancellation;
    } catch (error) {
      if (!disposed && isStateError("CANCELLED")) setState({ kind: "error", ...normalizeError(error) });
    }
  };
  const loadSaved = (query: SavedQuery, params: SqlParams = query.params) => {
    if (disposed) return;
    if (activeRun) void cancel();
    setSaved(query);
    setText(query.sql);
    setValues({ ...query.params, ...params });
    setResult(null);
    setSaveError(null);
    contentVersion++;
    setState({ kind: query.sql.trim() ? "ready" : "empty" });
    syncRoute();
  };
  const persist = async (name?: string) => {
    if (!canSave()) return null;
    const input = checkedInput();
    if (!input) return null;
    const query = saved();
    if (!query && name === undefined) return null;
    const snapshot = contentVersion;
    const signature = JSON.stringify([query?.id, name, query?.revision, input]);
    if (saveReceipt?.signature !== signature) saveReceipt = { signature, key: (options.newOperationId ?? createSqlRunId)() };
    const idempotencyKey = saveReceipt.key;
    setSaving(true);
    setSaveError(null);
    setSaveOperation("save");
    lastSaveName = name;
    try {
      const value =
        name !== undefined
          ? await client.create(options.base.id, { ...input, name }, lifetime.signal, idempotencyKey)
          : await client.update(
              options.base.id,
              query!.id,
              { ...input, name: query!.name, expectedRevision: query!.revision },
              lifetime.signal,
              idempotencyKey,
            );
      if (disposed) return null;
      // Edits made during save remain local and dirty; selecting another query never gets overwritten.
      if (saved()?.id === query?.id) {
        setSaved(value);
        if (snapshot === contentVersion) setValues((previous) => ({ ...previous, ...value.params }));
        syncRoute();
      }
      return value;
    } catch (error) {
      if (!disposed) setSaveError(normalizeError(error));
      return null;
    } finally {
      if (!disposed) setSaving(false);
    }
  };
  const deleteQuery = async () => {
    const query = saved();
    if (!query || saving() || disposed) return false;
    setSaving(true);
    setSaveError(null);
    setSaveOperation("delete");
    try {
      if (deleteReceipt?.queryId !== query.id || deleteReceipt.revision !== query.revision)
        deleteReceipt = { queryId: query.id, revision: query.revision, key: (options.newOperationId ?? createSqlRunId)() };
      await client.delete(options.base.id, query.id, query.revision, lifetime.signal, deleteReceipt.key);
      if (disposed) return false;
      if (saved()?.id === query.id) {
        setSaved(null);
        syncRoute();
      }
      return true;
    } catch (error) {
      if (!disposed) setSaveError(normalizeError(error));
      return false;
    } finally {
      if (!disposed) setSaving(false);
    }
  };
  const reloadSaved = async () => {
    const query = saved();
    if (!query || disposed || saving()) return;
    const snapshot = contentVersion;
    setSaving(true);
    try {
      const value = await client.get(options.base.id, query.id, lifetime.signal);
      if (!disposed && saved()?.id === query.id && snapshot === contentVersion) loadSaved(value);
    } catch (error) {
      if (!disposed) setSaveError(normalizeError(error));
    } finally {
      if (!disposed) setSaving(false);
    }
  };
  const launchAssistant = async () => {
    if (disposed || assistantState() === "launching") return;
    setAssistantState("launching");
    try {
      const launched = await (options.launchAssistant ?? launchPulseSqlAssistant)({
        base: options.base,
        sql: sql(),
        params: activeParams(),
        queryName: saved()?.name,
        locale: locale(),
      });
      if (disposed) return;
      setAssistantState("idle");
      options.onAssistantLaunched?.(launched);
    } catch {
      if (!disposed) setAssistantState("failed");
    }
  };
  const number = (value: number, maximumFractionDigits = 1) => new Intl.NumberFormat(locale(), { maximumFractionDigits }).format(value);
  const inputByteCount = () => new TextEncoder().encode(sql()).length;
  const inputBytesOverLimit = () => inputByteCount() > SQL_MAX_BYTES;
  const inputParametersOverLimit = () => parameterNames().length > SQL_MAX_PARAMETERS;
  const inputBytes = () => t().sqlInputBytes({ used: number(inputByteCount() / 1024), max: number(SQL_MAX_BYTES / 1024) });
  const inputParameters = () => t().sqlInputParameters({ used: number(parameterNames().length, 0), max: number(SQL_MAX_PARAMETERS, 0) });
  const limitSegments = () => {
    const value = limits();
    if (!value) return [];
    const storeT = baseStoreMessages.resolve([locale()]).t;
    const messages = t();
    return [
      {
        kind: "profile",
        text: messages.sqlLimitProfile({
          profile: { small: storeT.profileSmall, normal: storeT.profileNormal, large: storeT.profileLarge }[value.profile],
        }),
        separator: "",
      },
      { kind: "memory", text: messages.sqlLimitMemory({ memory: number(value.memoryBytes / 1_000_000_000) }), separator: ", " },
      { kind: "time", text: messages.sqlLimitTime({ seconds: number(value.timeSeconds) }), separator: " · " },
      {
        kind: "result",
        text: messages.sqlLimitResult({ rows: number(value.maxRows, 0), result: number(value.maxResultBytes / 1024 ** 2) }),
        separator: " · ",
      },
      {
        kind: "quota",
        text: messages.sqlLimitQuota({ used: number(value.queriesUsed, 0), quota: number(value.queriesPerHour, 0) }),
        separator: " · ",
      },
      {
        kind: "queue",
        text: messages.sqlLimitQueue({
          baseSlots: number(value.baseSlots, 0),
          cloudSlots: number(value.cloudSlots, 0),
          waiting: number(value.maxWaiting, 0),
          wait: number(value.waitMs / 1000),
        }),
        separator: "",
      },
    ];
  };
  const limitsLine = () =>
    limitSegments()
      .map((segment) => segment.text + segment.separator)
      .join("");
  // The field and its visible diagnosis share this source, independent of status priority.
  const missingParameter = () => {
    const current = state();
    if (current.kind !== "error" || !current.details.parameterName) return null;
    return { name: current.details.parameterName, message: t().sqlMissingHelp({ name: current.details.parameterName }) };
  };
  const assistantBand = (): SqlStatusBand | null => {
    const messages = t();
    if (assistantState() === "launching") return { kind: "running", message: messages.sqlAssistantLaunching };
    if (assistantState() === "failed")
      return {
        kind: "error",
        title: messages.sqlAssistantFailureTitle,
        message: messages.sqlAssistantUnchanged,
        diagnosis: { title: messages.sqlAssistantFailureTitle, message: messages.sqlAssistantHelp },
        action: { kind: "retry-assistant", label: messages.sqlRetry, run: launchAssistant },
      };
    return null;
  };
  const saveErrorBand = (): SqlStatusBand | null => {
    const messages = t();
    const writeError = saveError();
    if (writeError) {
      const conflict = writeError.cause instanceof SqlClientError && writeError.cause.status === 409;
      const nameConflict = conflict && saveOperation() === "save" && lastSaveName !== undefined;
      return {
        kind: "error",
        message: nameConflict
          ? messages.sqlNameConflict
          : conflict
            ? messages.sqlConflict
            : saveOperation() === "delete"
              ? messages.sqlDeleteFailed
              : messages.sqlSaveFailed,
        action: nameConflict
          ? { kind: "save-as", label: messages.sqlChooseName, run: () => options.onSaveAsRequested?.() }
          : conflict
            ? { kind: "reload-saved", label: messages.sqlReloadSaved, run: reloadSaved }
            : saveOperation() === "delete"
              ? { kind: "retry-delete", label: messages.sqlRetry, run: deleteQuery }
              : { kind: "retry-save", label: messages.sqlRetry, run: () => persist(lastSaveName) },
      };
    }
    return null;
  };
  const quotaBand = (): SqlStatusBand | null => {
    const messages = t();
    if (quotaBlocked())
      return {
        kind: "warning",
        title: messages.sqlQuota,
        message: `${messages.sqlQuotaReset({
          resetAt: new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(
            new Date(quotaResetAt()!),
          ),
        })}${limitsError() ? ` · ${messages.sqlUsageRefreshFailed}` : ""}`,
        diagnosis: {
          title: messages.sqlQuota,
          message: `${messages.sqlQuotaReset({ resetAt: new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(new Date(quotaResetAt()!)) })}. ${messages.sqlQuotaHelp}${limitsError() ? ` ${messages.sqlUsageRefreshFailed}` : ""}`,
        },
        action: limitsError() ? { kind: "retry-limits", label: messages.sqlRetry, run: refreshLimits } : undefined,
      };
    return null;
  };
  const runErrorBand = (): SqlStatusBand | null => {
    const messages = t();
    const current = state();
    if (current.kind === "error") {
      const detail = current.details;
      const byCode: Record<string, string> = {
        SQL_ERROR: detail.line
          ? messages.sqlErrorPosition({ line: number(detail.line, 0), column: detail.column ? number(detail.column, 0) : undefined })
          : messages.sqlError,
        TIME_LIMIT: messages.sqlTimeLimit,
        MEMORY_LIMIT: messages.sqlMemoryLimit,
        RESULT_TOO_LARGE: messages.sqlResultTooLarge,
        INPUT_TOO_LARGE: `${messages.sqlInputTooLarge} · ${inputBytes()} · ${messages.sqlInputParameters({ used: number(parameterNames().length, 0), max: number(SQL_MAX_PARAMETERS, 0) })}`,
        PARAMETER_MISSING: messages.sqlMissingParameter({ name: detail.parameterName ?? "" }),
        BUSY: messages.sqlBusy,
        QUEUE_FULL: messages.sqlQueueFull,
        QUOTA: messages.sqlQuota,
        STORE_UNAVAILABLE: messages.sqlStoreUnavailable,
        NO_READ_ACCESS: messages.sqlNoReadAccess,
        CANCELLED: messages.sqlCancelled,
      };
      const value = limits();
      const profile = value
        ? baseStoreMessages.resolve([locale()]).t[
            ({ small: "profileSmall", normal: "profileNormal", large: "profileLarge" } as const)[value.profile]
          ]
        : "";
      const time = value ? messages.sqlProfileTime({ profile, seconds: number(value.timeSeconds) }) : "";
      const memory = value ? messages.sqlProfileMemory({ profile, memory: number(value.memoryBytes / 1e9) }) : "";
      const presentations: Record<string, { title: string; message: string; diagnosis: NonNullable<SqlStatusBand["diagnosis"]> }> = {
        TIME_LIMIT: {
          title: messages.sqlTimeLimit,
          message: time || messages.sqlTimeLimit,
          diagnosis: { title: messages.sqlTimeLimit, message: [time, messages.sqlTimeHelp].filter(Boolean).join(". ") },
        },
        MEMORY_LIMIT: {
          title: messages.sqlMemoryTitle,
          message: memory || messages.sqlMemoryTitle,
          diagnosis: { title: messages.sqlMemoryTitle, message: [memory, messages.sqlMemoryHelp].filter(Boolean).join(". ") },
        },
        BUSY: {
          title: messages.sqlBusyTitle,
          message: messages.sqlBusyDetail,
          diagnosis: { title: messages.sqlBusyTitle, message: messages.sqlBusyHelp, kind: "error" },
        },
        QUEUE_FULL: {
          title: messages.sqlBusyTitle,
          message: messages.sqlQueueDetail,
          diagnosis: { title: messages.sqlBusyTitle, message: messages.sqlQueueHelp, kind: "error" },
        },
        STORE_UNAVAILABLE: {
          title: messages.sqlStoreUnavailable,
          message: messages.sqlStoreUnavailable,
          diagnosis: { title: messages.sqlStoreUnavailable, message: messages.sqlStoreHelp },
        },
        NO_READ_ACCESS: {
          title: messages.sqlNoReadTitle,
          message: messages.sqlNoReadTitle,
          diagnosis: { title: messages.sqlNoReadTitle, message: messages.sqlNoReadAccess },
        },
      };
      const action =
        current.code === "PARAMETER_MISSING" && detail.parameterName
          ? {
              kind: "focus-parameter" as const,
              label: messages.sqlParameterFocus,
              parameterName: detail.parameterName,
              run: () => options.focusParameter?.(detail.parameterName!),
            }
          : ["INPUT_TOO_LARGE", "NO_READ_ACCESS", "QUOTA"].includes(current.code)
            ? undefined
            : { kind: "retry" as const, label: messages.sqlRetry, run };
      return {
        title:
          current.code === "PARAMETER_MISSING"
            ? messages.sqlParameterMissing
            : current.code === "SQL_ERROR"
              ? messages.sqlError
              : current.code === "INPUT_TOO_LARGE"
                ? messages.sqlInputTooLargeTitle
                : (byCode[current.code] ?? messages.sqlRequestFailed),
        kind: ["BUSY", "QUEUE_FULL", "QUOTA", "CANCELLED"].includes(current.code) ? "warning" : "error",
        message:
          current.code === "SQL_ERROR" && current.message
            ? `${byCode.SQL_ERROR} · ${current.message}`
            : (byCode[current.code] ?? messages.sqlRequestFailed),
        ...presentations[current.code],
        action,
      };
    }
    return null;
  };
  const limitsErrorBand = (): SqlStatusBand | null => {
    const messages = t();
    if (limitsError())
      return {
        kind: "error",
        message:
          limitsError()?.code === "NO_READ_ACCESS"
            ? messages.sqlNoReadAccess
            : limitsError()?.code === "STORE_UNAVAILABLE"
              ? messages.sqlStoreUnavailable
              : messages.sqlRequestFailed,
        action: { kind: "retry-limits", label: messages.sqlRetry, run: refreshLimits },
      };
    return null;
  };
  const statusBand = (): SqlStatusBand => {
    const messages = t();
    const current = state();
    if (current.kind === "running")
      return { kind: "running", message: messages.sqlRunning, action: { kind: "cancel", label: messages.sqlCancel, run: cancel } };
    const failure = assistantBand() ?? saveErrorBand() ?? quotaBand() ?? runErrorBand() ?? limitsErrorBand();
    if (failure) return failure;
    const result = lastResult();
    if (current.kind === "ok" && result)
      return {
        kind: result.truncated ? "warning" : "ok",
        title: result.truncated ? messages.sqlTruncated : undefined,
        message: `${messages.sqlResultSummary({ rows: number(result.rowCount, 0), elapsed: number(result.stats.elapsedMs), read: number(result.stats.readBytes / 1024 ** 2) })}`,
      };
    return { kind: "neutral", message: current.kind === "empty" ? messages.sqlEmpty : messages.sqlReady };
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopRunTimer?.();
    stopRunTimer = undefined;
    stopQuotaTimer?.();
    lifetime.abort();
    activeRun?.abort.abort();
    activeRun = null;
  };
  onCleanup(dispose);
  onMount(() => {
    if (!initial?.limits && !initial?.error) void refreshLimits();
  });
  return {
    sql,
    setSql,
    parameterNames,
    parameterValues,
    setParameter,
    chosenQuery,
    hasUnsavedChanges,
    state,
    lastResult,
    limits,
    limitsLoading,
    limitsError,
    refreshLimits,
    quotaResetAt,
    quotaBlocked,
    canRun,
    canSave,
    inputBytes,
    inputBytesOverLimit,
    inputParametersOverLimit,
    inputParameters,
    limitSegments,
    limitsLine,
    statusBand,
    runningElapsedText: () => t().sqlRequestElapsed({ seconds: number(elapsedSeconds(), 0) }),
    missingParameter,
    assistantBand,
    saveErrorBand,
    quotaBand,
    runErrorBand,
    limitsErrorBand,
    run,
    cancel,
    retry: run,
    loadSaved,
    saving,
    saveError,
    save: () => persist(),
    saveAs: (name: string) => persist(name),
    delete: deleteQuery,
    reloadSaved,
    assistantState,
    launchAssistant,
    retryAssistant: launchAssistant,
    dispose,
  };
};
export type SqlConsoleController = ReturnType<typeof createSqlConsoleController>;
