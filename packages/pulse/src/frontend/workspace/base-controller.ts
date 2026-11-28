import { mutation } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { type Accessor, onCleanup, type Setter } from "solid-js";
import type { PulseBase } from "../../contracts";
import type { BaseRetention } from "../../store/admin-contracts";
import { jsonFetch } from "../http";
import { usePulseMessages } from "../use-messages";
import { baseStoreMessages } from "./base-store-messages";
import { baseUpdateError, RetentionConfirmationError, retentionPreviewLines } from "./retention-confirmation";

export type BaseSettingsSaveResult = "failed" | "persisted";

export type BaseSettingsInput = {
  name: string;
  icon: string;
  color: string;
  timezone: string;
  description: string;
  rawRetentionDays: number;
  rollupRetentionDays: number;
  sensitiveRetentionHours: number;
};

type BaseControllerDeps = {
  loading: Accessor<boolean>;
  setLoading: Setter<boolean>;
  /** Reports a finished or failed deed in one sentence (the screen's toast). */
  notify: (text: string, status: "ok" | "bad") => void;
  /** Asks before something that cannot be taken back; resolves true when the person agrees. */
  confirm: (question: { title: string; description: string; confirm: string }) => Promise<boolean>;
  refreshBase: () => Promise<void>;
  writeBlocked: Accessor<boolean>;
  /** Where the person goes after the base's deletion started. */
  leave: () => void;
};

/** The writes on a base from its settings: save, clear its data, delete it, resume a failed store step. */
export const createBaseController = (deps: BaseControllerDeps) => {
  const t = usePulseMessages();
  const locale = useLocale();
  let disposed = false;
  type SettingsIntent = Omit<BaseSettingsInput, "description"> & {
    baseId: string;
    description: string | null;
    /** Set only after the person confirmed the date and amount a shorter retention removes. */
    confirmShorterRetention?: true;
    expectedRetention?: BaseRetention;
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
  const reconcile = async (message: string): Promise<boolean> => {
    try {
      await deps.refreshBase();
      return !disposed;
    } catch {
      if (!disposed) deps.notify(message, "bad");
      return false;
    }
  };
  const requireWritable = (): boolean => {
    if (!deps.writeBlocked()) return true;
    deps.notify(t().refreshBeforeChanges, "bad");
    return false;
  };

  /** Checks the ranges, saves, and asks with date and amount first when a shorter retention removes data. */
  const updateSettings = async (base: PulseBase, input: BaseSettingsInput): Promise<BaseSettingsSaveResult> => {
    if (!requireWritable()) return "failed";
    const name = input.name.trim();
    const invalid = !name
      ? t().pulseNameRequired
      : !Number.isInteger(input.rawRetentionDays) || input.rawRetentionDays < 1 || input.rawRetentionDays > 3650
        ? t().rawRetentionRange
        : !Number.isInteger(input.rollupRetentionDays) || input.rollupRetentionDays < 1 || input.rollupRetentionDays > 3650
          ? t().rollupRetentionRange
          : !Number.isInteger(input.sensitiveRetentionHours) || input.sensitiveRetentionHours < 1 || input.sensitiveRetentionHours > 8760
            ? t().sensitiveRetentionRange
            : null;
    if (invalid) {
      deps.notify(invalid, "bad");
      return "failed";
    }
    deps.setLoading(true);
    try {
      const intent: SettingsIntent = { ...input, baseId: base.id, name, description: input.description.trim() || null };
      let outcome = await updateMutation.mutate(intent);
      if (disposed) return "failed";
      const refused = outcome === "error" ? updateMutation.error() : null;
      if (refused instanceof RetentionConfirmationError) {
        // A shorter retention deletes data: save only after the person saw from when and how much.
        const words = baseStoreMessages.resolve([locale()]).t;
        const lines = retentionPreviewLines(refused.preview, locale(), Intl.DateTimeFormat().resolvedOptions().timeZone);
        const agreed = await deps.confirm({
          title: words.confirmShorterTitle,
          description: [words.confirmShorterIntro, ...lines].join(" "),
          confirm: words.confirmShorter,
        });
        if (!agreed || disposed) return "failed";
        outcome = await updateMutation.mutate({ ...intent, confirmShorterRetention: true, expectedRetention: refused.previewedFrom });
        if (disposed) return "failed";
      }
      if (outcome === "error") throw updateMutation.error();
      if (outcome !== "success") return "failed";
      if (!(await reconcile(t().settingsSavedRefreshFailed))) return "persisted";
      deps.notify(t().settingsSaved, "ok");
      return "persisted";
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : t().settingsUpdateFailed, "bad");
      return "failed";
    } finally {
      deps.setLoading(false);
    }
  };

  const clearData = async (base: PulseBase) => {
    if (!requireWritable()) return;
    const agreed = await deps.confirm({
      title: t().clearPulseData,
      description: t().clearDataConfirm({ name: base.name }),
      confirm: t().clearData,
    });
    if (disposed || !agreed || !requireWritable()) return;
    deps.setLoading(true);
    try {
      const outcome = await clearMutation.mutate(base.id);
      if (disposed) return;
      if (outcome === "error") throw clearMutation.error();
      if (outcome !== "success") return;
      if (!(await reconcile(t().clearDataStartedRefreshFailed))) return;
      deps.notify(t().clearDataStarted, "ok");
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : t().clearDataFailed, "bad");
    } finally {
      deps.setLoading(false);
    }
  };

  const deleteBase = async (base: PulseBase) => {
    if (!requireWritable()) return false;
    const agreed = await deps.confirm({
      title: t().deletePulseBase,
      description: t().deleteBaseConfirm({ name: base.name }),
      confirm: t().delete,
    });
    if (disposed || !agreed || !requireWritable()) return false;
    deps.setLoading(true);
    try {
      const outcome = await deleteMutation.mutate(base.id);
      if (disposed) return false;
      if (outcome === "error") throw deleteMutation.error();
      if (outcome !== "success") return false;
      deps.notify(t().deleteBaseStarted, "ok");
      deps.leave();
      return true;
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : t().deleteBaseFailed, "bad");
      return false;
    } finally {
      deps.setLoading(false);
    }
  };

  const retryStore = async (base: PulseBase): Promise<PulseBase | null> => {
    deps.setLoading(true);
    try {
      const outcome = await retryMutation.mutate(base.id);
      if (disposed) return null;
      if (outcome === "error") throw retryMutation.error();
      if (outcome !== "success") return null;
      const next = retryMutation.data() ?? null;
      await reconcile(t().settingsSavedRefreshFailed);
      if (!disposed) deps.notify(baseStoreMessages.resolve([locale()]).t.retryStarted, "ok");
      return next;
    } catch {
      if (!disposed) deps.notify(baseStoreMessages.resolve([locale()]).t.retryFailed, "bad");
      return null;
    } finally {
      deps.setLoading(false);
    }
  };

  return { updateSettings, clearData, deleteBase, retryStore, requireWritable };
};
