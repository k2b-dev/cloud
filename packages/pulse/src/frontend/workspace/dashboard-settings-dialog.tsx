import {
  Button,
  confirmDiscardIfDirty,
  NoticeCard,
  prompts,
  Select,
  SettingsField,
  SettingsGroup,
  SettingsModal,
  SettingsPanelFooter,
  TextInput,
} from "@k2b/ui";
import { type Accessor, createSignal, Show } from "solid-js";
import type { PulseDashboard } from "../../contracts";
import { DASHBOARD_REFRESH_OPTIONS, refreshOptionFromConfig } from "./helpers";
import type { RefreshIntervalOption } from "./types";
import { usePulseMessages } from "../use-messages";

type DashboardSettingsDialogOptions = {
  currentDashboard: Accessor<PulseDashboard>;
  dashboard: PulseDashboard;
  loading: Accessor<boolean>;
  updateDashboardSettings: (
    dashboard: PulseDashboard,
    input: { name: string; refreshInterval: RefreshIntervalOption },
  ) => Promise<DashboardWriteResult>;
  enablePublicLink: (dashboard: PulseDashboard, options: { copy: boolean }) => Promise<void>;
  disablePublicLink: (dashboard: PulseDashboard) => Promise<void>;
  deleteDashboard: (dashboard: PulseDashboard) => Promise<DashboardWriteResult>;
  writeBlocked: Accessor<boolean>;
};

export type DashboardWriteResult = "failed" | "persisted" | "reconciled";

export const openPulseDashboardSettingsDialog = (options: DashboardSettingsDialogOptions) =>
  prompts.dialog<void>(
    (close) => {
      const t = usePulseMessages();
      const [name, setName] = createSignal(options.dashboard.name);
      const [refreshInterval, setRefreshInterval] = createSignal<RefreshIntervalOption>(refreshOptionFromConfig(options.dashboard.config));
      const [saved, setSaved] = createSignal({ name: options.dashboard.name, refreshInterval: refreshInterval() });
      const changeCount = () => Number(name() !== saved().name) + Number(refreshInterval() !== saved().refreshInterval);
      const discard = () => {
        setName(saved().name);
        setRefreshInterval(saved().refreshInterval);
      };
      const save = async () => {
        const next = { name: name(), refreshInterval: refreshInterval() };
        if ((await options.updateDashboardSettings(options.currentDashboard(), next)) !== "failed") setSaved(next);
      };
      const requestClose = async () => {
        if (!options.loading() && (await confirmDiscardIfDirty(() => changeCount() > 0))) close();
      };

      return (
        <div class="flex h-[72vh] min-h-0 flex-col overflow-hidden">
          <SettingsModal
            title={t().dashboardSettings}
            subtitle={options.dashboard.name}
            icon="ti ti-layout-dashboard"
            onClose={() => void requestClose()}
            closeLabel={t().close}
          >
            <SettingsModal.Group title={t().dashboard}>
              <SettingsModal.Tab
                id="general"
                title={t().general}
                icon="ti ti-settings"
                description={t().dashboardGeneralDescription}
              >
                <SettingsGroup title={t().display} description={t().dashboardDisplayDescription}>
                  <SettingsField
                    label={t().name}
                    description={t().dashboardNameDescription}
                    error={() => (!name().trim() ? t().nameRequired : undefined)}
                    changed={() => name() !== saved().name}
                  >
                    <TextInput aria-label={t().name} icon="ti ti-tag" value={name} onValueChange={setName} required />
                  </SettingsField>
                  <SettingsField
                    label={t().autoRefresh}
                    description={t().autoRefreshDescription}
                    error={() => undefined}
                    changed={() => refreshInterval() !== saved().refreshInterval}
                  >
                    <Select
                      aria-label={t().autoRefresh}
                      icon="ti ti-refresh"
                      value={refreshInterval}
                      onValueChange={(value) => setRefreshInterval(value as RefreshIntervalOption)}
                      options={DASHBOARD_REFRESH_OPTIONS.map((option) => ({
                        ...option,
                        label:
                          option.id === "1"
                            ? t().everyOneSecond
                            : option.id === "60"
                              ? t().everyMinute
                              : option.id === "never"
                                ? t().never
                                : t().everySeconds({ seconds: Number(option.id) }),
                      }))}
                    />
                  </SettingsField>
                </SettingsGroup>
                <SettingsModal.Footer>
                  <SettingsPanelFooter changeCount={changeCount} loading={options.loading} onDiscard={discard} onSave={() => void save()} />
                </SettingsModal.Footer>
              </SettingsModal.Tab>
            </SettingsModal.Group>

            <SettingsModal.Group title={t().sharing}>
              <SettingsModal.Tab
                id="public-link"
                title={t().publicLink}
                icon="ti ti-link"
                description={t().publicLinkDescription}
              >
                <SettingsGroup title={t().publicAccess} description={t().changesImmediate}>
                  <NoticeCard tone={options.currentDashboard().publicEnabled ? "success" : "info"} icon={false}>
                    {options.currentDashboard().publicEnabled
                      ? t().publicEnabledDescription
                      : t().publicDisabledDescription}
                  </NoticeCard>
                  <div class="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={options.loading() || options.writeBlocked()}
                      onClick={() => void options.enablePublicLink(options.currentDashboard(), { copy: true })}
                    >
                      <i class="ti ti-copy" />
                      {options.currentDashboard().publicEnabled ? t().copyPublicLink : t().createPublicLink}
                    </Button>
                    <Show when={options.currentDashboard().publicEnabled}>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={options.loading() || options.writeBlocked()}
                        onClick={() => void options.disablePublicLink(options.currentDashboard())}
                      >
                        <i class="ti ti-link-off" />
                        {t().disablePublicLink}
                      </Button>
                    </Show>
                  </div>
                </SettingsGroup>
              </SettingsModal.Tab>
            </SettingsModal.Group>

            <SettingsModal.Group title={t().lifecycle}>
              <SettingsModal.Tab
                id="danger"
                title={t().dangerZone}
                icon="ti ti-alert-triangle"
                tone="danger"
                description={t().deleteDashboard}
              >
                <SettingsGroup title={t().deleteDashboard} description={t().deleteDashboardDescription}>
                  <SettingsGroup.Action>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      disabled={options.loading() || options.writeBlocked()}
                      onClick={() => void options.deleteDashboard(options.dashboard).then((result) => result !== "failed" && close())}
                    >
                      <i class="ti ti-trash text-sm" />
                      {t().deleteDashboard}
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
