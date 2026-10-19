import { mutation } from "@k2b/stdlib/solid";
import { prompts, toast, useLocale } from "@k2b/ui";
import { type Accessor, onCleanup, type Setter } from "solid-js";
import type { PulseBase } from "../../contracts";
import { jsonFetch } from "../http";
import { usePulseMessages } from "../use-messages";
import { type BaseSettingsSaveResult, openPulseBaseSettingsDialog } from "./base-settings-dialog";
import { baseStoreMessages } from "./base-store-messages";
import { baseUpdateError, confirmShorterRetention, RetentionConfirmationError } from "./retention-confirmation";

type BaseControllerDeps = {
  bases: Accessor<PulseBase[]>;
  selectedBase: Accessor<PulseBase | null>;
  loading: Accessor<boolean>;
  settingsDialogOpen: Accessor<boolean>;
  setLoading: Setter<boolean>;
  setSettingsDialogOpen: Setter<boolean>;
  refreshBases: () => Promise<void>;
  refreshWorkspace: () => Promise<void>;
  writeBlocked: Accessor<boolean>;
  navigateToBase: (baseId: string) => void;
};

export const createBaseController = (deps: BaseControllerDeps) => {
  const t = usePulseMessages();
  const locale = useLocale();
  let disposed = false;
  type SettingsIntent = {
    baseId: string;
    name: string;
    description: string | null;
    rawRetentionDays: number;
    rollupRetentionDays: number;
    sensitiveRetentionHours: number;
    /** Set only after the person confirmed the date and amount a shorter retention removes. */
    confirmShorterRetention?: true;
  };
  const updateMutation = mutation.create<PulseBase, SettingsIntent>({
    mutation: ({ baseId, ...body }, { abortSignal }) =>
      jsonFetch<PulseBase>(
        `/api/pulse/bases/${baseId}`,
        { method: "PATCH", body: JSON.stringify(body), signal: abortSignal },
        "Request failed",
        baseUpdateError,
      ),
  });
  const retryMutation = mutation.create<PulseBase, string>({
    mutation: (baseId, { abortSignal }) =>
      jsonFetch<PulseBase>(`/api/pulse/bases/${baseId}/retry`, { method: "POST", signal: abortSignal }),
  });
  const clearMutation = mutation.create<void, string>({
    mutation: (baseId, { abortSignal }) =>
      jsonFetch<void>(`/api/pulse/bases/${baseId}/clear-data`, { method: "POST", signal: abortSignal }),
  });
  const deleteMutation = mutation.create<void, string>({
    mutation: (baseId, { abortSignal }) => jsonFetch<void>(`/api/pulse/bases/${baseId}`, { method: "DELETE", signal: abortSignal }),
  });
  onCleanup(() => {
    disposed = true;
    updateMutation.abort();
    retryMutation.abort();
    clearMutation.abort();
    deleteMutation.abort();
  });
  const reconcile = async (refresh: () => Promise<void>, message: string): Promise<boolean> => {
    try {
      await refresh();
      return !disposed;
    } catch {
      if (!disposed) toast.error(message);
      return false;
    }
  };
  const requireWritable = (): boolean => {
    if (!deps.writeBlocked()) return true;
    toast.error(t().refreshBeforeChanges);
    return false;
  };

  const updateSettings = async (
    base: PulseBase,
    input: {
      name: string;
      description: string;
      rawRetentionDays: number;
      rollupRetentionDays: number;
      sensitiveRetentionHours: number;
    },
  ): Promise<BaseSettingsSaveResult> => {
    if (!requireWritable()) return "failed";
    const name = input.name.trim();
    if (!name) {
      toast.error(t().pulseNameRequired);
      return "failed";
    }
    if (!Number.isInteger(input.rawRetentionDays) || input.rawRetentionDays < 1 || input.rawRetentionDays > 3650) {
      toast.error(t().rawRetentionRange);
      return "failed";
    }
    if (!Number.isInteger(input.rollupRetentionDays) || input.rollupRetentionDays < 1 || input.rollupRetentionDays > 3650) {
      toast.error(t().rollupRetentionRange);
      return "failed";
    }
    if (!Number.isInteger(input.sensitiveRetentionHours) || input.sensitiveRetentionHours < 1 || input.sensitiveRetentionHours > 8760) {
      toast.error(t().sensitiveRetentionRange);
      return "failed";
    }
    deps.setLoading(true);
    try {
      const intent: SettingsIntent = {
        baseId: base.id,
        name,
        description: input.description.trim() || null,
        rawRetentionDays: input.rawRetentionDays,
        rollupRetentionDays: input.rollupRetentionDays,
        sensitiveRetentionHours: input.sensitiveRetentionHours,
      };
      await updateMutation.mutate(intent);
      if (disposed) return "failed";
      const refused = updateMutation.error();
      if (refused instanceof RetentionConfirmationError) {
        // A shorter retention deletes data: save only after the person saw from when and how much.
        if (!(await confirmShorterRetention(refused.preview, locale())) || disposed) return "failed";
        await updateMutation.mutate({ ...intent, confirmShorterRetention: true });
        if (disposed) return "failed";
      }
      if (updateMutation.error()) throw updateMutation.error();
      if (
        !(await reconcile(
          () => Promise.all([deps.refreshBases(), deps.refreshWorkspace()]).then(() => undefined),
          t().settingsSavedRefreshFailed,
        ))
      )
        return "persisted";
      toast.success(t().settingsSaved);
      return "persisted";
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().settingsUpdateFailed);
      return "failed";
    } finally {
      deps.setLoading(false);
    }
  };

  const clearData = async (base: PulseBase) => {
    if (!requireWritable()) return;
    const confirmed = await prompts.confirm(t().clearDataConfirm({ name: base.name }), {
      title: t().clearPulseData,
      variant: "danger",
      confirmText: t().clearData,
    });
    if (disposed || !confirmed || !requireWritable()) return;

    deps.setLoading(true);
    try {
      await clearMutation.mutate(base.id);
      if (disposed) return;
      if (clearMutation.error()) throw clearMutation.error();
      if (!(await reconcile(deps.refreshWorkspace, t().clearDataStartedRefreshFailed))) return;
      toast.success(t().clearDataStarted);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().clearDataFailed);
    } finally {
      deps.setLoading(false);
    }
  };

  const deleteBase = async (base: PulseBase) => {
    if (!requireWritable()) return false;
    const confirmed = await prompts.confirm(t().deleteBaseConfirm({ name: base.name }), {
      title: t().deletePulseBase,
      variant: "danger",
      confirmText: t().delete,
    });
    if (disposed || !confirmed || !requireWritable()) return false;

    deps.setLoading(true);
    try {
      await deleteMutation.mutate(base.id);
      if (disposed) return false;
      if (deleteMutation.error()) throw deleteMutation.error();
      if (!(await reconcile(deps.refreshBases, t().deleteBaseStartedRefreshFailed))) return false;
      const nextBase = deps.bases().find((item) => item.id !== base.id) ?? null;
      deps.navigateToBase(nextBase?.id ?? "");

      toast.success(t().deleteBaseStarted);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().deleteBaseFailed);
      return false;
    } finally {
      deps.setLoading(false);
    }
  };

  const retryStore = async (base: PulseBase): Promise<PulseBase | null> => {
    deps.setLoading(true);
    try {
      await retryMutation.mutate(base.id);
      if (disposed) return null;
      if (retryMutation.error()) throw retryMutation.error();
      const next = retryMutation.data() ?? null;
      await reconcile(deps.refreshBases, t().settingsSavedRefreshFailed);
      if (!disposed) toast.success(baseStoreMessages.resolve([locale()]).t.retryStarted);
      return next;
    } catch {
      if (!disposed) toast.error(baseStoreMessages.resolve([locale()]).t.retryFailed);
      return null;
    } finally {
      deps.setLoading(false);
    }
  };

  const openSettings = async () => {
    if (deps.settingsDialogOpen()) return;
    const base = deps.selectedBase();
    if (!base) return;
    try {
      deps.setSettingsDialogOpen(true);
      await openPulseBaseSettingsDialog({
        base,
        loading: deps.loading,
        writeBlocked: deps.writeBlocked,
        updateBaseSettings: updateSettings,
        currentStore: () => deps.selectedBase()?.store ?? null,
        retryStore: () => retryStore(base),
        clearBaseData: () => clearData(base),
        deleteBase: () => deleteBase(base),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().openSettingsFailed);
    } finally {
      deps.setLoading(false);
      deps.setSettingsDialogOpen(false);
    }
  };

  return { openSettings };
};
