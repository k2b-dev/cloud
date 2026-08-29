import { mutation, query } from "@k2b/stdlib/solid";
import {
  Button,
  confirmDiscardIfDirty,
  NoticeCard,
  NumberInput,
  prompts,
  SettingsField,
  SettingsGroup,
  SettingsModal,
  SettingsPanelFooter,
  TextInput,
  toast,
} from "@k2b/ui";
import { PermissionEditor } from "@valentinkolb/cloud/access/ui";
import type { AccessEntry, Principal } from "@valentinkolb/cloud/contracts";
import { type Accessor, createSignal, onCleanup, Show } from "solid-js";
import type { PulseBase } from "../../contracts";
import { jsonFetch } from "./helpers";
import type { GrantableLevel } from "./types";
import { usePulseMessages } from "../use-messages";

type BaseSettingsDialogOptions = {
  base: PulseBase;
  loading: Accessor<boolean>;
  updateBaseSettings: (
    base: PulseBase,
    input: {
      name: string;
      description: string;
      rawRetentionDays: number;
      rollupRetentionDays: number;
      sensitiveRetentionHours: number;
    },
  ) => Promise<BaseSettingsSaveResult>;
  writeBlocked: Accessor<boolean>;
  clearBaseData: () => Promise<void>;
  deleteBase: () => Promise<boolean>;
};

export type BaseSettingsSaveResult = "failed" | "persisted";

export const openPulseBaseSettingsDialog = (options: BaseSettingsDialogOptions) =>
  prompts.dialog<void>(
    (close) => {
      const t = usePulseMessages();
      let disposed = false;
      const [name, setName] = createSignal(options.base.name);
      const [description, setDescription] = createSignal(options.base.description ?? "");
      const [rawRetentionDays, setRawRetentionDays] = createSignal<number | null>(options.base.rawRetentionDays);
      const [rollupRetentionDays, setRollupRetentionDays] = createSignal<number | null>(options.base.rollupRetentionDays);
      const [sensitiveRetentionHours, setSensitiveRetentionHours] = createSignal<number | null>(options.base.sensitiveRetentionHours);
      const [saved, setSaved] = createSignal({
        name: options.base.name,
        description: options.base.description ?? "",
        rawRetentionDays: options.base.rawRetentionDays,
        rollupRetentionDays: options.base.rollupRetentionDays,
        sensitiveRetentionHours: options.base.sensitiveRetentionHours,
      });
      const access = query.create({
        source: () => options.base.id,
        load: (baseId, { abortSignal }) => jsonFetch<AccessEntry[]>(`/api/pulse/bases/${baseId}/access`, { signal: abortSignal }),
      });
      const draft = () => ({
        name: name(),
        description: description(),
        rawRetentionDays: rawRetentionDays() ?? options.base.rawRetentionDays,
        rollupRetentionDays: rollupRetentionDays() ?? options.base.rollupRetentionDays,
        sensitiveRetentionHours: sensitiveRetentionHours() ?? options.base.sensitiveRetentionHours,
      });
      const changeCount = () => {
        const current = draft();
        const baseline = saved();
        return (Object.keys(current) as Array<keyof typeof current>).filter((key) => current[key] !== baseline[key]).length;
      };
      const discard = () => {
        const baseline = saved();
        setName(baseline.name);
        setDescription(baseline.description);
        setRawRetentionDays(baseline.rawRetentionDays);
        setRollupRetentionDays(baseline.rollupRetentionDays);
        setSensitiveRetentionHours(baseline.sensitiveRetentionHours);
      };
      const saveSettings = async () => {
        const next = draft();
        if ((await options.updateBaseSettings(options.base, next)) === "persisted") setSaved(next);
      };

      const grantMutation = mutation.create<AccessEntry, { principal: Principal; permission: GrantableLevel }>({
        mutation: ({ principal, permission }, { abortSignal }) =>
          jsonFetch<AccessEntry>(`/api/pulse/bases/${options.base.id}/access`, {
            method: "POST",
            body: JSON.stringify({ principal, permission }),
            signal: abortSignal,
          }),
      });
      const updateMutation = mutation.create<void, { accessId: string; permission: GrantableLevel }>({
        mutation: ({ accessId, permission }, { abortSignal }) =>
          jsonFetch<void>(`/api/pulse/bases/${options.base.id}/access/${accessId}`, {
            method: "PATCH",
            body: JSON.stringify({ permission }),
            signal: abortSignal,
          }),
      });
      const revokeMutation = mutation.create<void, string>({
        mutation: (accessId, { abortSignal }) =>
          jsonFetch<void>(`/api/pulse/bases/${options.base.id}/access/${accessId}`, { method: "DELETE", signal: abortSignal }),
      });
      const refreshAccess = async () => {
        try {
          await access.invalidate();
        } catch {
          if (!disposed) toast.error(t().accessChangedRefreshFailed);
        }
      };
      const requireAccessWritable = () => {
        if (!access.stale() && !access.loading() && !access.refreshing()) return;
        throw new Error(t().refreshAccessBeforeChanges);
      };
      const grantAccess = async (principal: Principal, permission: GrantableLevel) => {
        requireAccessWritable();
        await grantMutation.mutate({ principal, permission });
        if (disposed) throw new DOMException("Settings dialog was disposed", "AbortError");
        const error = grantMutation.error();
        if (error) throw error;
        await refreshAccess();
        if (disposed) throw new DOMException("Settings dialog was disposed", "AbortError");
        return grantMutation.data()!;
      };
      const updateAccess = async (accessId: string, permission: GrantableLevel) => {
        requireAccessWritable();
        await updateMutation.mutate({ accessId, permission });
        if (disposed) throw new DOMException("Settings dialog was disposed", "AbortError");
        const error = updateMutation.error();
        if (error) throw error;
        await refreshAccess();
        if (disposed) throw new DOMException("Settings dialog was disposed", "AbortError");
      };
      const revokeAccess = async (accessId: string) => {
        requireAccessWritable();
        await revokeMutation.mutate(accessId);
        if (disposed) throw new DOMException("Settings dialog was disposed", "AbortError");
        const error = revokeMutation.error();
        if (error) throw error;
        await refreshAccess();
        if (disposed) throw new DOMException("Settings dialog was disposed", "AbortError");
      };
      const accessBusy = () => grantMutation.loading() || updateMutation.loading() || revokeMutation.loading() || access.refreshing();
      const requestClose = async () => {
        if (options.loading() || accessBusy()) return;
        if (await confirmDiscardIfDirty(() => changeCount() > 0)) close();
      };

      onCleanup(() => {
        disposed = true;
        grantMutation.abort();
        updateMutation.abort();
        revokeMutation.abort();
      });

      return (
        <div class="flex h-[86vh] min-h-0 flex-col overflow-hidden">
          <SettingsModal
            title={t().pulseSettings}
            subtitle={options.base.name}
            icon="ti ti-activity-heartbeat"
            onClose={() => void requestClose()}
            closeLabel={t().close}
          >
            <SettingsModal.Group title={t().base}>
              <SettingsModal.Tab id="general" title={t().general} icon="ti ti-settings" description={t().baseGeneralDescription}>
                <SettingsGroup title={t().identity} description={t().identityDescription}>
                  <SettingsField
                    label={t().name}
                    description={t().baseNameDescription}
                    error={() => (!name().trim() ? t().nameRequired : undefined)}
                    changed={() => name() !== saved().name}
                  >
                    <TextInput aria-label={t().name} icon="ti ti-tag" value={name} onValueChange={setName} required />
                  </SettingsField>
                  <SettingsField
                    label={t().description}
                    description={t().baseDescriptionDescription}
                    error={() => undefined}
                    changed={() => description() !== saved().description}
                  >
                    <TextInput
                      aria-label={t().description}
                      icon="ti ti-align-left"
                      value={description}
                      onValueChange={setDescription}
                      multiline
                      lines={3}
                      placeholder={t().optional}
                    />
                  </SettingsField>
                </SettingsGroup>
                <SettingsModal.Footer>
                  <SettingsPanelFooter
                    changeCount={changeCount}
                    loading={options.loading}
                    onDiscard={discard}
                    onSave={() => void saveSettings()}
                  />
                </SettingsModal.Footer>
              </SettingsModal.Tab>
            </SettingsModal.Group>

            <SettingsModal.Group title={t().sharing}>
              <SettingsModal.Tab id="access" title={t().access} icon="ti ti-users" description={t().accessDescription}>
                <SettingsGroup title={t().peopleAndGroups} description={t().peopleAndGroupsDescription}>
                  <Show when={access.data() && access.error()}>
                    {(error) => (
                      <NoticeCard tone="danger" title={t().accessRefreshFailed} detail={error().message}>
                        <Button onClick={() => void access.refresh()}>{t().retry}</Button>
                      </NoticeCard>
                    )}
                  </Show>
                  <Show
                    keyed
                    when={access.data()}
                    fallback={
                      <NoticeCard
                        tone={access.error() ? "danger" : "neutral"}
                        title={access.error() ? t().accessLoadFailed : t().loadingAccess}
                        detail={access.error()?.message}
                      >
                        {access.error() ? <Button onClick={() => void access.refresh()}>{t().retry}</Button> : null}
                      </NoticeCard>
                    }
                  >
                    {(entries) => (
                      <PermissionEditor
                        initialEntries={entries}
                        canEdit
                        grantAccess={grantAccess}
                        updateAccess={updateAccess}
                        revokeAccess={revokeAccess}
                        allowedLevels={[
                          { level: "read", label: t().view, icon: "ti-eye" },
                          { level: "write", label: t().edit, icon: "ti-pencil" },
                          { level: "admin", label: t().manage, icon: "ti-shield" },
                        ]}
                      />
                    )}
                  </Show>
                </SettingsGroup>
              </SettingsModal.Tab>
            </SettingsModal.Group>

            <SettingsModal.Group title={t().data}>
              <SettingsModal.Tab
                id="retention"
                title={t().retention}
                icon="ti ti-clock-cog"
                description={t().retentionTabDescription}
              >
                <SettingsGroup title={t().dataLifecycle} description={t().dataLifecycleDescription}>
                  <SettingsField
                    label={t().rawDataRetention}
                    description={t().rawDataRetentionDescription}
                    error={() => undefined}
                    changed={() => draft().rawRetentionDays !== saved().rawRetentionDays}
                  >
                    <NumberInput
                      aria-label={t().rawDataRetention}
                      icon="ti ti-clock"
                      suffix={t().days}
                      min={1}
                      max={3650}
                      value={rawRetentionDays}
                      onValueChange={setRawRetentionDays}
                      required
                    />
                  </SettingsField>
                  <SettingsField
                    label={t().hourlyRollupRetention}
                    description={t().hourlyRollupRetentionDescription}
                    error={() => undefined}
                    changed={() => draft().rollupRetentionDays !== saved().rollupRetentionDays}
                  >
                    <NumberInput
                      aria-label={t().hourlyRollupRetention}
                      icon="ti ti-chart-histogram"
                      suffix={t().days}
                      min={1}
                      max={3650}
                      value={rollupRetentionDays}
                      onValueChange={setRollupRetentionDays}
                      required
                    />
                  </SettingsField>
                  <SettingsField
                    label={t().sensitiveEventRetention}
                    description={t().sensitiveEventRetentionDescription}
                    error={() => undefined}
                    changed={() => draft().sensitiveRetentionHours !== saved().sensitiveRetentionHours}
                  >
                    <NumberInput
                      aria-label={t().sensitiveEventRetention}
                      icon="ti ti-shield-lock"
                      suffix={t().hours}
                      min={1}
                      max={8760}
                      value={sensitiveRetentionHours}
                      onValueChange={setSensitiveRetentionHours}
                      required
                    />
                  </SettingsField>
                </SettingsGroup>
                <SettingsModal.Footer>
                  <SettingsPanelFooter
                    changeCount={changeCount}
                    loading={options.loading}
                    onDiscard={discard}
                    onSave={() => void saveSettings()}
                  />
                </SettingsModal.Footer>
              </SettingsModal.Tab>
            </SettingsModal.Group>

            <SettingsModal.Group title={t().lifecycle}>
              <SettingsModal.Tab
                id="danger"
                title={t().dangerZone}
                icon="ti ti-alert-triangle"
                tone="danger"
                description={t().destructiveBaseActions}
              >
                <SettingsGroup
                  title={t().clearTelemetry}
                  description={t().clearTelemetryDescription}
                >
                  <SettingsGroup.Action>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      disabled={options.loading() || options.writeBlocked()}
                      onClick={() => void options.clearBaseData()}
                    >
                      <i class="ti ti-eraser text-sm" />
                      {t().clearTelemetry}
                    </Button>
                  </SettingsGroup.Action>
                </SettingsGroup>
                <SettingsGroup
                  title={t().deletePulseBase}
                  description={t().deletePulseBaseDescription}
                >
                  <SettingsGroup.Action>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      disabled={options.loading() || options.writeBlocked()}
                      onClick={() => void options.deleteBase().then((deleted) => deleted && close())}
                    >
                      <i class="ti ti-trash text-sm" />
                      {t().deletePulseBase}
                    </Button>
                  </SettingsGroup.Action>
                </SettingsGroup>
              </SettingsModal.Tab>
            </SettingsModal.Group>
          </SettingsModal>
        </div>
      );
    },
    { surface: "bare", header: false, size: "large" },
  );
