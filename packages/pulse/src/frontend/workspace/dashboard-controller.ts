import { clipboard } from "@k2b/stdlib/browser";
import { mutation, query } from "@k2b/stdlib/solid";
import { prompts, toast } from "@k2b/ui";
import { type Accessor, createSignal, onCleanup, type Setter } from "solid-js";
import type { PulseDashboard, PulseDashboardConfig, PulseDashboardControl, PulseDashboardDslCompileResult } from "../../contracts";
import { jsonFetch } from "../http";
import {
  compileDashboardDslText,
  createPublicDashboardToken,
  dashboardDslCompileError,
  deletePublicDashboardToken,
  savePulseDashboardConfig,
} from "./dashboard-actions";
import {
  dashboardDslPreviewIsCurrent,
  dashboardPreviewConfigFromResult,
  dashboardToDsl,
  emptyDashboardDsl,
  shouldSkipDashboardDslPreview,
} from "./dashboard-dsl-helpers";
import { type DashboardWriteResult, openPulseDashboardSettingsDialog } from "./dashboard-settings-dialog";
import {
  openPublicDashboardDisplayDialog as openPublicDashboardDisplayOptionsDialog,
  type PublicDashboardDisplayHeight,
  type PublicDashboardDisplayTheme,
} from "./public-display-dialog";
import type { RefreshIntervalOption, WorkspaceView } from "./types";
import { refreshIntervalFromOption } from "./workspace-options";
import { usePulseMessages } from "../use-messages";

type DashboardControllerDeps = {
  selectedBaseId: Accessor<string>;
  selectedDashboard: Accessor<PulseDashboard | null>;
  selectedDashboardId: Accessor<string>;
  dashboards: Accessor<PulseDashboard[]>;
  setSelectedDashboardId: Setter<string>;
  loading: Accessor<boolean>;
  setLoading: Setter<boolean>;
  origin: Accessor<string>;
  activeView: Accessor<WorkspaceView>;
  dashboardDslText: Accessor<string>;
  setDashboardDslText: Setter<string>;
  dashboardDslDiagnostics: Accessor<PulseDashboardDslCompileResult | null>;
  setDashboardDslDiagnostics: Setter<PulseDashboardDslCompileResult | null>;
  dashboardDslDiagnosticsText: Accessor<string>;
  setDashboardDslDiagnosticsText: Setter<string>;
  dashboardPreviewConfig: Accessor<PulseDashboardConfig | null>;
  setDashboardPreviewConfig: Setter<PulseDashboardConfig | null>;
  setDashboardDslSeededFor: Setter<string>;
  setDashboardDslSaving: Setter<boolean>;
  dashboardControlValues: Accessor<Record<string, Record<string, string>>>;
  setDashboardControlValues: Setter<Record<string, Record<string, string>>>;
  navigate: (state: { view: WorkspaceView; dashboardId?: string }) => void;
  refreshBaseData: () => Promise<void>;
  refreshDashboard: (dashboard?: PulseDashboard | null) => Promise<void>;
  refreshDashboardConfig: (config: PulseDashboardConfig, dashboard?: PulseDashboard | null, baseId?: string) => Promise<void>;
  writeBlocked: Accessor<boolean>;
};

export const createDashboardController = (deps: DashboardControllerDeps) => {
  const t = usePulseMessages();
  let disposed = false;
  let compileRequestId = 0;
  const createMutation = mutation.create<PulseDashboard, { baseId: string; name: string; dsl: string }>({
    mutation: ({ baseId, name, dsl }, { abortSignal }) =>
      jsonFetch<PulseDashboard>(`/api/pulse/bases/${baseId}/dashboards`, {
        method: "POST",
        body: JSON.stringify({ name, config: { dsl } }),
        signal: abortSignal,
      }),
  });
  const [compileIntent, setCompileIntent] = createSignal<{ baseId: string; text: string; requestId: number } | null>(null);
  const compileQuery = query.create({
    source: compileIntent,
    enabled: () => compileIntent() !== null,
    load: (intent, { abortSignal }) => {
      if (!intent) throw new Error("No dashboard compile requested");
      return compileDashboardDslText(intent.baseId, intent.text, abortSignal);
    },
  });
  const saveMutation = mutation.create<PulseDashboard, { dashboard: PulseDashboard; config: PulseDashboardConfig }>({
    mutation: ({ dashboard, config }, { abortSignal }) => savePulseDashboardConfig(dashboard, config, abortSignal),
  });
  const publicLinkMutation = mutation.create<{ dashboard: PulseDashboard; token: string }, { dashboardId: string }>({
    mutation: ({ dashboardId }, { abortSignal }) => createPublicDashboardToken(dashboardId, abortSignal),
  });
  const disablePublicLinkMutation = mutation.create<PulseDashboard, { dashboardId: string }>({
    mutation: ({ dashboardId }, { abortSignal }) => deletePublicDashboardToken(dashboardId, abortSignal),
  });
  const settingsMutation = mutation.create<PulseDashboard, { dashboardId: string; name: string; config: PulseDashboardConfig }>({
    mutation: ({ dashboardId, name, config }, { abortSignal }) =>
      jsonFetch<PulseDashboard>(`/api/pulse/dashboards/${dashboardId}`, {
        method: "PATCH",
        body: JSON.stringify({ name, config }),
        signal: abortSignal,
      }),
  });
  const deleteMutation = mutation.create<void, { dashboardId: string }>({
    mutation: ({ dashboardId }, { abortSignal }) =>
      jsonFetch<void>(`/api/pulse/dashboards/${dashboardId}`, { method: "DELETE", signal: abortSignal }),
  });
  onCleanup(() => {
    disposed = true;
    createMutation.abort();
    saveMutation.abort();
    publicLinkMutation.abort();
    disablePublicLinkMutation.abort();
    settingsMutation.abort();
    deleteMutation.abort();
  });
  const reconcile = async (tasks: Array<() => Promise<void>>, message: string, notify = true): Promise<boolean> => {
    try {
      await Promise.all(tasks.map((task) => task()));
      return !disposed;
    } catch {
      if (!disposed && notify) toast.error(message);
      return false;
    }
  };
  const requireWritable = (): boolean => {
    if (!deps.writeBlocked()) return true;
    toast.error(t().refreshBeforeChanges);
    return false;
  };

  const createDashboard = async () => {
    if (!requireWritable()) return null;
    const baseId = deps.selectedBaseId();
    if (!baseId) return null;
    const result = await prompts.form({
      title: t().newDashboard,
      icon: "ti ti-layout-dashboard",
      fields: {
        name: { type: "text", label: t().name, required: true, placeholder: "Operations" },
        description: { type: "text", label: t().description, multiline: true, placeholder: t().dashboardQuestionPlaceholder },
      },
      confirmText: t().create,
    });
    if (disposed || !result || !requireWritable()) return null;
    const name = String(result.name ?? "").trim();
    if (!name) return null;
    const dsl = emptyDashboardDsl(name, String(result.description ?? "").trim());
    deps.setLoading(true);
    try {
      await createMutation.mutate({ baseId, name, dsl });
      if (disposed) return null;
      if (createMutation.error()) throw createMutation.error();
      const dashboard = createMutation.data()!;
      if (!(await reconcile([deps.refreshBaseData], t().dashboardCreatedRefreshFailed)))
        return null;
      const dashboardDsl = dashboardToDsl(dashboard);
      deps.setDashboardDslText(dashboardDsl);
      deps.setDashboardPreviewConfig(dashboard.config);
      deps.setDashboardDslDiagnostics({ ok: true, diagnostics: [], config: dashboard.config });
      deps.setDashboardDslDiagnosticsText(dashboardDsl);
      deps.setDashboardDslSeededFor(dashboard.id);
      deps.setSelectedDashboardId(dashboard.id);
      deps.navigate({ view: "dashboard-edit", dashboardId: dashboard.id });
      toast.success(t().dashboardCreated);
      return dashboard;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().dashboardCreateFailed);
      return null;
    } finally {
      deps.setLoading(false);
    }
  };

  const compilePreview = async (dashboard: PulseDashboard, text: string) => {
    const baseId = deps.selectedBaseId();
    if (shouldSkipDashboardDslPreview(baseId, text)) {
      deps.setDashboardDslDiagnostics(null);
      deps.setDashboardDslDiagnosticsText("");
      return;
    }
    const requestId = ++compileRequestId;
    const previewIsCurrent = () =>
      dashboardDslPreviewIsCurrent({
        currentDashboardId: deps.selectedDashboard()?.id,
        currentRequestId: compileRequestId,
        currentText: deps.dashboardDslText(),
        dashboardId: dashboard.id,
        requestId,
        text,
      });
    try {
      setCompileIntent({ baseId, text, requestId });
      await compileQuery.refresh();
      if (disposed) return;
      if (compileQuery.error()) throw compileQuery.error();
      const result = compileQuery.data()!;
      if (!previewIsCurrent()) return;
      deps.setDashboardDslDiagnostics(result);
      deps.setDashboardDslDiagnosticsText(text);
      const previewConfig = dashboardPreviewConfigFromResult(result);
      if (previewConfig) {
        deps.setDashboardPreviewConfig(previewConfig);
        await deps.refreshDashboardConfig(previewConfig, dashboard, baseId);
        if (disposed) return;
      }
    } catch (error) {
      if (disposed) return;
      if (!previewIsCurrent()) return;
      deps.setDashboardDslDiagnostics(dashboardDslCompileError(error));
      deps.setDashboardDslDiagnosticsText(text);
    }
  };

  const saveDsl = async () => {
    if (!requireWritable()) return;
    const dashboard = deps.selectedDashboard();
    const compiled = deps.dashboardDslDiagnostics();
    if (!dashboard || deps.dashboardDslDiagnosticsText() !== deps.dashboardDslText() || !compiled?.ok || !compiled.config) {
      toast.error(t().fixDashboardDsl);
      return;
    }
    deps.setDashboardDslSaving(true);
    try {
      const config: PulseDashboardConfig = {
        ...compiled.config,
        refreshIntervalSeconds: dashboard.config.refreshIntervalSeconds,
      };
      await saveMutation.mutate({ dashboard, config });
      if (disposed) return;
      if (saveMutation.error()) throw saveMutation.error();
      const updated = saveMutation.data()!;
      if (!(await reconcile([deps.refreshBaseData], t().dashboardSavedListRefreshFailed))) return;
      deps.setDashboardDslSeededFor("");
      if (!(await reconcile([() => deps.refreshDashboard(updated)], t().dashboardSavedDataRefreshFailed)))
        return;
      deps.navigate({ view: "dashboard", dashboardId: updated.id });
      toast.success(t().dashboardSaved);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().dashboardSaveFailed);
    } finally {
      deps.setDashboardDslSaving(false);
    }
  };

  const publicUrl = (token: string, options: { theme?: PublicDashboardDisplayTheme; height?: PublicDashboardDisplayHeight } = {}) => {
    const base = deps.origin() || (typeof window !== "undefined" ? window.location.origin : "");
    const url = new URL(`/app/pulse/display/${token}`, base || "http://localhost");
    if (options.theme) url.searchParams.set("theme", options.theme);
    if (options.height === "full") url.searchParams.set("height", "full");
    return base ? url.toString() : `${url.pathname}${url.search}`;
  };

  const ensurePublicLink = async (
    dashboard: PulseDashboard,
    options: { theme?: PublicDashboardDisplayTheme; height?: PublicDashboardDisplayHeight } = {},
  ) => {
    if (deps.writeBlocked()) throw new Error(t().refreshBeforeChanges);
    await publicLinkMutation.mutate({ dashboardId: dashboard.id });
    if (disposed) throw new DOMException("Dashboard owner was disposed", "AbortError");
    if (publicLinkMutation.error()) throw publicLinkMutation.error();
    const result = publicLinkMutation.data()!;
    if (!(await reconcile([deps.refreshBaseData], t().publicLinkCreatedRefreshFailed, false))) {
      if (disposed) throw new DOMException("Dashboard owner was disposed", "AbortError");
      throw new Error(t().publicLinkCreatedRefreshFailed);
    }
    return publicUrl(result.token, options);
  };

  const enablePublicLink = async (dashboard = deps.selectedDashboard(), options: { copy?: boolean } = {}) => {
    if (!dashboard) return;
    deps.setLoading(true);
    try {
      const link = await ensurePublicLink(dashboard);
      if (disposed) return;
      if (options.copy) await clipboard.copy(link);
      if (disposed) return;
      toast.success(options.copy ? t().publicDashboardLinkCopied : t().publicDashboardLinkEnabled);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().publicLinkCreateFailed);
    } finally {
      deps.setLoading(false);
    }
  };

  const disablePublicLink = async (dashboard = deps.selectedDashboard()) => {
    if (!requireWritable()) return;
    if (!dashboard) return;
    deps.setLoading(true);
    try {
      await disablePublicLinkMutation.mutate({ dashboardId: dashboard.id });
      if (disposed) return;
      if (disablePublicLinkMutation.error()) throw disablePublicLinkMutation.error();
      if (!(await reconcile([deps.refreshBaseData], t().publicLinkDisabledRefreshFailed)))
        return;
      toast.success(t().publicDashboardLinkDisabled);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().publicLinkDisableFailed);
    } finally {
      deps.setLoading(false);
    }
  };

  const openPublicDisplay = (dashboard: PulseDashboard) =>
    openPublicDashboardDisplayOptionsDialog({ resolveLink: (options) => ensurePublicLink(dashboard, options) });

  const updateSettings = async (
    dashboard: PulseDashboard,
    input: { name: string; refreshInterval: RefreshIntervalOption },
  ): Promise<DashboardWriteResult> => {
    if (!requireWritable()) return "failed";
    const name = input.name.trim();
    if (!name) {
      toast.error(t().dashboardNameRequired);
      return "failed";
    }
    deps.setLoading(true);
    try {
      const config: PulseDashboardConfig = {
        ...dashboard.config,
        refreshIntervalSeconds: refreshIntervalFromOption(input.refreshInterval),
      };
      await settingsMutation.mutate({ dashboardId: dashboard.id, name, config });
      if (disposed) return "failed";
      if (settingsMutation.error()) throw settingsMutation.error();
      if (!(await reconcile([deps.refreshBaseData], t().dashboardUpdatedRefreshFailed)))
        return "persisted";
      toast.success(t().dashboardUpdated);
      return "reconciled";
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().dashboardUpdateFailed);
      return "failed";
    } finally {
      deps.setLoading(false);
    }
  };

  const deleteDashboard = async (dashboard: PulseDashboard): Promise<DashboardWriteResult> => {
    if (!requireWritable()) return "failed";
    const confirmed = await prompts.confirm(t().deleteDashboardConfirm({ name: dashboard.name }), { title: t().deleteDashboard, variant: "danger" });
    if (disposed || !confirmed || !requireWritable()) return "failed";
    deps.setLoading(true);
    try {
      await deleteMutation.mutate({ dashboardId: dashboard.id });
      if (disposed) return "failed";
      if (deleteMutation.error()) throw deleteMutation.error();
      if (!(await reconcile([deps.refreshBaseData], t().dashboardDeletedRefreshFailed))) {
        if (deps.selectedDashboardId() === dashboard.id) deps.navigate({ view: "dashboard" });
        return "persisted";
      }
      const fallback = deps.dashboards().find((item) => item.id !== dashboard.id) ?? null;
      if (deps.selectedDashboardId() === dashboard.id)
        deps.navigate(fallback ? { view: "dashboard", dashboardId: fallback.id } : { view: "dashboard" });
      toast.success(t().dashboardDeleted);
      return "reconciled";
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().dashboardDeleteFailed);
      return "failed";
    } finally {
      deps.setLoading(false);
    }
  };

  const openSettings = async (dashboard: PulseDashboard) => {
    try {
      await openPulseDashboardSettingsDialog({
        currentDashboard: () => deps.dashboards().find((item) => item.id === dashboard.id) ?? dashboard,
        dashboard,
        loading: deps.loading,
        writeBlocked: deps.writeBlocked,
        updateDashboardSettings: updateSettings,
        enablePublicLink,
        disablePublicLink,
        deleteDashboard,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().openDashboardSettingsFailed);
    }
  };

  const updateControl = (dashboard: PulseDashboard, control: PulseDashboardControl, value: string, config = dashboard.config) => {
    const nextValues = { ...(deps.dashboardControlValues()[dashboard.id] ?? {}), [control.variable]: value };
    if (typeof window !== "undefined" && (deps.activeView() === "dashboard" || deps.activeView() === "dashboard-edit")) {
      const url = new URL(window.location.href);
      for (const key of [...url.searchParams.keys()]) if (key.startsWith("c_")) url.searchParams.delete(key);
      for (const item of config.layout?.controls ?? []) {
        const current = nextValues[item.variable] ?? item.defaultValue;
        if (current !== item.defaultValue) url.searchParams.set(`c_${item.variable}`, current);
      }
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
    }
    deps.setDashboardControlValues((current) => ({ ...current, [dashboard.id]: nextValues }));
    queueMicrotask(() => {
      const preview =
        deps.activeView() === "dashboard-edit" && dashboard.id === deps.selectedDashboard()?.id ? deps.dashboardPreviewConfig() : null;
      void (preview ? deps.refreshDashboardConfig(preview, dashboard) : deps.refreshDashboard(dashboard));
    });
  };

  return {
    compilePreview,
    createDashboard,
    deleteDashboard,
    disablePublicLink,
    enablePublicLink,
    openPublicDisplay,
    openSettings,
    saveDsl,
    updateControl,
    updateSettings,
  };
};
