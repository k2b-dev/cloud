import { PermissionEditor } from "@k2b/cloud/access/ui";
import type { AccessEntry, Principal } from "@k2b/cloud/contracts";
import { text } from "@k2b/stdlib";
import { mutation, query } from "@k2b/stdlib/solid";
import {
  Button,
  confirmDiscardIfDirty,
  DescriptionList,
  Format,
  IconButton,
  IconInput,
  NoticeCard,
  NumberInput,
  Placeholder,
  ProgressBar,
  prompts,
  SettingsField,
  SettingsGroup,
  SettingsModal,
  SettingsPanelFooter,
  Skeleton,
  StatusBadge,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { type Accessor, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { BASE_COLORS } from "../../base-settings";
import type { PulseBase } from "../../contracts";
import type { BaseStoreStatus } from "../../store/admin-contracts";
import { usePulseMessages } from "../use-messages";
import { type BaseStoreMessages, baseStoreMessages } from "./base-store-messages";
import { jsonFetch } from "./helpers";
import type { PulseSettingsTab } from "./routes";
import { sqlClient } from "./sql-client";
import type { GrantableLevel } from "./types";

type BaseSettingsDialogOptions = {
  base: PulseBase;
  canAdmin: boolean;
  admins: string[];
  maxRawRetentionDays: number;
  initialTab?: PulseSettingsTab;
  signal?: AbortSignal;
  onTabChange?: (tab: PulseSettingsTab) => void;
  onCloseRequestReady?: (request: () => Promise<boolean>) => void;
  loading: Accessor<boolean>;
  refreshBase: () => Promise<void>;
  updateBaseSettings: (
    base: PulseBase,
    input: {
      name: string;
      icon: string;
      color: string;
      timezone: string;
      description: string;
      rawRetentionDays: number;
      rollupRetentionDays: number;
      sensitiveRetentionHours: number;
    },
  ) => Promise<BaseSettingsSaveResult>;
  writeBlocked: Accessor<boolean>;
  /** The base's store as the workspace's base list currently has it; it refreshes while an operation runs. */
  currentStore: Accessor<BaseStoreStatus | null>;
  /** Resumes the failed lifecycle step and refreshes the base list; resolves with the updated base, or null when it did not start. */
  retryStore: () => Promise<PulseBase | null>;
  clearBaseData: () => Promise<void>;
  deleteBase: () => Promise<boolean>;
};

export type BaseSettingsSaveResult = "failed" | "persisted";

const storeBadge = (t: BaseStoreMessages, store: BaseStoreStatus) => {
  if (store.state === "active")
    return store.writeBlockReason
      ? { tone: "warning" as const, label: t.stateWriteBlocked, icon: "ti ti-lock" }
      : { tone: "ok" as const, label: t.stateActive, icon: "ti ti-circle-check" };
  if (store.state === "failed") return { tone: "error" as const, label: t.stateFailed, icon: "ti ti-alert-circle" };
  const label = { provisioning: t.stateProvisioning, clearing: t.stateClearing, deleting: t.stateDeleting }[store.state];
  return { tone: "running" as const, label, icon: "ti ti-loader-2" };
};
const failedText = (t: BaseStoreMessages, store: BaseStoreStatus) =>
  store.operation === "clear" ? t.failedClear : store.operation === "delete" ? t.failedDelete : t.failedProvision;

/** The base's own database: state with "Retry" in a fixed place, usage against its threshold, and limits. */
const StoreStatusGroup = (props: { store: () => BaseStoreStatus; busy: () => boolean; onRetry: () => void }) => {
  const locale = useLocale();
  const t = createMemo(() => baseStoreMessages.resolve([locale()]).t);
  const badge = () => storeBadge(t(), props.store());
  const notice = () => {
    const store = props.store();
    if (store.state === "failed") return { tone: "danger" as const, text: failedText(t(), store), retry: true };
    if (store.state === "active" && store.writeBlockReason) return { tone: "warning" as const, text: t().blockedText, retry: false };
    if (store.state !== "active") return { tone: "neutral" as const, text: t().busyText, retry: false };
    return null;
  };
  return (
    <SettingsGroup title={t().storeTitle} description={t().storeDescription}>
      <DescriptionList
        layout="rows"
        items={[
          {
            term: t().state,
            description: (
              <span class="flex flex-col gap-1" aria-live="polite">
                <StatusBadge tone={badge().tone} variant="text" icon={badge().icon} label={badge().label} />
                <Show when={notice()}>{(value) => <span class="text-xs text-secondary">{value().text}</span>}</Show>
              </span>
            ),
            action: (
              <Show when={notice()?.retry}>
                <Button size="xs" variant="secondary" loading={props.busy()} onClick={() => props.onRetry()}>
                  {t().retry}
                </Button>
              </Show>
            ),
          },
          {
            term: t().limits,
            description: t().limitsSummary({
              values: text.pprintNumber(props.store().limits.valuesPerMinute, { locale: locale() }),
              series: text.pprintNumber(props.store().limits.maxSeries, { locale: locale() }),
              profile: { small: t().profileSmall, normal: t().profileNormal, large: t().profileLarge }[props.store().profile],
            }),
          },
        ]}
      />
    </SettingsGroup>
  );
};

export const openPulseBaseSettingsDialog = (options: BaseSettingsDialogOptions) =>
  prompts.dialog<void>(
    (close, context) => {
      const t = usePulseMessages();
      const locale = useLocale();
      const storeT = createMemo(() => baseStoreMessages.resolve([locale()]).t);
      let disposed = false;
      const store = () => options.currentStore() ?? options.base.store;
      // A Cloud admin decides about a checkpoint mismatch first; clearing would take away the restore option.
      const clearBlocked = () => Boolean(store().writeBlockReason);
      const [retrying, setRetrying] = createSignal(false);
      const retry = async () => {
        if (retrying()) return;
        setRetrying(true);
        try {
          await options.retryStore();
        } finally {
          setRetrying(false);
        }
      };
      const [icon, setIcon] = createSignal(options.base.icon);
      const [color, setColor] = createSignal(options.base.color);
      const [timezone, setTimezone] = createSignal(options.base.timezone);
      const [name, setName] = createSignal(options.base.name);
      const [description, setDescription] = createSignal(options.base.description ?? "");
      const [rawRetentionDays, setRawRetentionDays] = createSignal<number | null>(options.base.rawRetentionDays);
      const [rollupRetentionDays, setRollupRetentionDays] = createSignal<number | null>(options.base.rollupRetentionDays);
      const [sensitiveRetentionHours, setSensitiveRetentionHours] = createSignal<number | null>(options.base.sensitiveRetentionHours);
      const [saved, setSaved] = createSignal({
        name: options.base.name,
        icon: options.base.icon,
        color: options.base.color,
        timezone: options.base.timezone,
        description: options.base.description ?? "",
        rawRetentionDays: options.base.rawRetentionDays,
        rollupRetentionDays: options.base.rollupRetentionDays,
        sensitiveRetentionHours: options.base.sensitiveRetentionHours,
      });
      const usage = query.create({
        source: () => options.base.id,
        load: (baseId, { abortSignal }) => sqlClient.limits(baseId, abortSignal),
      });
      const access = query.create({
        enabled: () => options.canAdmin,
        source: () => options.base.id,
        load: (baseId, { abortSignal }) => jsonFetch<AccessEntry[]>(`/api/pulse/bases/${baseId}/access`, { signal: abortSignal }),
      });
      const draft = () => ({
        name: name(),
        icon: icon(),
        color: color(),
        timezone: timezone(),
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
        setIcon(baseline.icon);
        setColor(baseline.color);
        setTimezone(baseline.timezone);
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
          await Promise.all([access.invalidate(), options.refreshBase()]);
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
      let checkingClose = false;
      const requestClose = async () => {
        if (checkingClose || options.loading() || accessBusy()) return false;
        checkingClose = true;
        try {
          if (!(await confirmDiscardIfDirty(() => changeCount() > 0)) || disposed) return false;
          close();
          return true;
        } finally {
          checkingClose = false;
        }
      };
      options.onCloseRequestReady?.(requestClose);
      context.setDismissHandler(async () => {
        await requestClose();
      });

      onCleanup(() => {
        disposed = true;
        grantMutation.abort();
        updateMutation.abort();
        revokeMutation.abort();
      });

      return (
        <div class="flex h-[86dvh] min-h-0 flex-col overflow-hidden md:h-[min(640px,86dvh)]">
          <SettingsModal
            defaultTab={options.initialTab}
            onTabChange={(tab) => {
              const valid = ["general", "members", "retention", "usage", "danger"] as const;
              const value = valid.find((value) => value === tab);
              if (value) options.onTabChange?.(value);
            }}
            title={t().pulseSettings}
            subtitle={options.base.name}
            icon="ti ti-activity-heartbeat"
            onClose={() => void requestClose()}
            closeLabel={t().close}
          >
            <SettingsModal.Tab id="general" title={t().general} icon="ti ti-settings" description={t().baseGeneralDescription}>
              <div class="flex max-w-[460px] flex-col gap-4">
                <Show when={!options.canAdmin}>
                  <p class="text-sm text-secondary">
                    <i class="ti ti-lock mr-2" aria-hidden="true" />
                    {t().settingsNotAdmin} {options.admins.join(", ")}
                  </p>
                </Show>
                <TextInput
                  label={t().name}
                  disabled={!options.canAdmin}
                  value={name}
                  onValueChange={setName}
                  required
                  error={() => (!name().trim() ? t().nameRequired : undefined)}
                />
                <div class="flex flex-col gap-2">
                  <span class="text-sm font-medium">{t().settingsAppearance}</span>
                  <div role="group" aria-label={t().settingsColor} class="flex flex-wrap gap-2.5 py-1">
                    <For each={BASE_COLORS}>
                      {(value) => (
                        <IconButton
                          variant="ghost"
                          class="h-[38px] w-[38px] rounded-[10px] p-0!"
                          disabled={!options.canAdmin}
                          label={
                            {
                              zinc: t().settingsColorGray,
                              blue: t().settingsColorBlue,
                              emerald: t().settingsColorGreen,
                              amber: t().settingsColorAmber,
                              red: t().settingsColorRed,
                            }[value]
                          }
                          aria-pressed={color() === value}
                          onClick={() => setColor(value)}
                          style={{
                            color: `color-mix(in srgb, var(--k2b-${{ zinc: "neutral", blue: "accent", emerald: "success", amber: "warning", red: "danger" }[value]}-500) 72%, var(--k2b-text))`,
                            background: `color-mix(in srgb, var(--k2b-${{ zinc: "neutral", blue: "accent", emerald: "success", amber: "warning", red: "danger" }[value]}-500) 16%, var(--k2b-surface))`,
                            "box-shadow": color() === value ? "0 0 0 2px var(--k2b-surface), 0 0 0 4px var(--k2b-action)" : undefined,
                          }}
                        >
                          <i class={`${icon()} text-lg`} aria-hidden="true" />
                        </IconButton>
                      )}
                    </For>
                  </div>
                  <IconInput aria-label={t().settingsIcon} value={icon} onValueChange={setIcon} disabled={!options.canAdmin} />
                </div>
                <TextInput
                  label={t().settingsTimezone}
                  description={t().settingsTimezoneHint}
                  value={timezone}
                  onValueChange={setTimezone}
                  disabled={!options.canAdmin}
                />
                <TextInput
                  label={t().settingsIdentifier}
                  description={t().settingsIdentifierHint}
                  value={options.base.shortId}
                  monospace
                  readOnly
                />
                <TextInput
                  label={t().description}
                  value={description}
                  onValueChange={setDescription}
                  multiline
                  lines={3}
                  placeholder={t().optional}
                  disabled={!options.canAdmin}
                />
              </div>

              <SettingsModal.Footer>
                <SettingsPanelFooter
                  changeCount={changeCount}
                  loading={options.loading}
                  onDiscard={discard}
                  onSave={() => options.canAdmin && void saveSettings()}
                />
              </SettingsModal.Footer>
            </SettingsModal.Tab>

            <SettingsModal.Tab id="members" title={t().settingsMembers} icon="ti ti-users" description={t().accessDescription}>
              <Show when={!options.canAdmin}>
                <NoticeCard title={t().settingsNotAdmin} detail={options.admins.join(", ")} />
              </Show>
              <Show when={options.canAdmin}>
                <SettingsGroup title={t().peopleAndGroups} description={t().peopleAndGroupsDescription}>
                  <Show when={access.data() && access.error()}>
                    {(error) => (
                      <NoticeCard tone="danger" title={t().accessRefreshFailed} detail={error().message}>
                        <Button onClick={() => void access.refresh()}>{t().retry}</Button>
                      </NoticeCard>
                    )}
                  </Show>
                  <Show
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
                        initialEntries={entries()}
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
              </Show>
            </SettingsModal.Tab>

            <SettingsModal.Tab id="retention" title={t().retention} icon="ti ti-clock-cog" description={t().retentionTabDescription}>
              <div class="max-w-[860px]">
                <SettingsField
                  class="px-0! md:grid! md:grid-cols-[170px_minmax(0,1fr)]! md:gap-x-7!"
                  label={t().rawDataRetention}
                  description={t().rawDataRetentionDescription}
                  error={() => undefined}
                  changed={() => draft().rawRetentionDays !== saved().rawRetentionDays}
                >
                  {({ describedBy }) => (
                    <div class="flex min-w-0 flex-col gap-2">
                      <div role="group" aria-label={t().rawDataRetention} aria-describedby={describedBy()} class="flex flex-wrap gap-1">
                        <For each={[7, 30, 90, 400, 730, 1095]}>
                          {(value) => (
                            <Button
                              aria-describedby={describedBy()}
                              size="sm"
                              variant="subtle"
                              aria-pressed={rawRetentionDays() === value}
                              disabled={!options.canAdmin || value > options.maxRawRetentionDays}
                              class="h-[34px] rounded-[9px]"
                              style={
                                rawRetentionDays() === value
                                  ? {
                                      color: "var(--k2b-action)",
                                      background: "var(--k2b-selected)",
                                      "box-shadow": "inset 0 0 0 1.5px color-mix(in srgb, var(--k2b-action) 40%, transparent)",
                                    }
                                  : undefined
                              }
                              onClick={() => setRawRetentionDays(value)}
                            >
                              {new Intl.NumberFormat(locale()).format(value)} {t().days}
                            </Button>
                          )}
                        </For>
                      </div>
                      <div class="w-full max-w-[280px]">
                        <NumberInput
                          aria-label={t().rawDataRetention}
                          aria-describedby={describedBy()}
                          icon="ti ti-clock"
                          suffix={t().days}
                          min={1}
                          max={options.maxRawRetentionDays}
                          disabled={!options.canAdmin}
                          value={rawRetentionDays}
                          onValueChange={setRawRetentionDays}
                          required
                        />
                      </div>
                    </div>
                  )}
                </SettingsField>
                <SettingsField
                  class="px-0! md:grid! md:grid-cols-[170px_minmax(0,1fr)]! md:gap-x-7!"
                  label={t().hourlyRollupRetention}
                  description={t().hourlyRollupRetentionDescription}
                  error={() => undefined}
                  changed={() => draft().rollupRetentionDays !== saved().rollupRetentionDays}
                >
                  {({ describedBy }) => (
                    <div class="flex min-w-0 flex-col gap-2">
                      <div
                        role="group"
                        aria-label={t().hourlyRollupRetention}
                        aria-describedby={describedBy()}
                        class="flex flex-wrap gap-1"
                      >
                        <For each={[365, 800, 1095, 3650]}>
                          {(value) => (
                            <Button
                              aria-describedby={describedBy()}
                              size="sm"
                              variant="subtle"
                              aria-pressed={rollupRetentionDays() === value}
                              disabled={!options.canAdmin || value > 3650}
                              class="h-[34px] rounded-[9px]"
                              style={
                                rollupRetentionDays() === value
                                  ? {
                                      color: "var(--k2b-action)",
                                      background: "var(--k2b-selected)",
                                      "box-shadow": "inset 0 0 0 1.5px color-mix(in srgb, var(--k2b-action) 40%, transparent)",
                                    }
                                  : undefined
                              }
                              onClick={() => setRollupRetentionDays(value)}
                            >
                              {new Intl.NumberFormat(locale()).format(value)} {t().days}
                            </Button>
                          )}
                        </For>
                      </div>
                      <div class="w-full max-w-[280px]">
                        <NumberInput
                          aria-label={t().hourlyRollupRetention}
                          aria-describedby={describedBy()}
                          icon="ti ti-chart-histogram"
                          suffix={t().days}
                          min={1}
                          max={3650}
                          disabled={!options.canAdmin}
                          value={rollupRetentionDays}
                          onValueChange={setRollupRetentionDays}
                          required
                        />
                      </div>
                    </div>
                  )}
                </SettingsField>
                <SettingsField
                  class="px-0! md:grid! md:grid-cols-[170px_minmax(0,1fr)]! md:gap-x-7!"
                  label={t().sensitiveEventRetention}
                  description={t().sensitiveEventRetentionDescription}
                  error={() => undefined}
                  changed={() => draft().sensitiveRetentionHours !== saved().sensitiveRetentionHours}
                >
                  {({ describedBy }) => (
                    <div class="flex min-w-0 flex-col gap-2">
                      <div
                        role="group"
                        aria-label={t().sensitiveEventRetention}
                        aria-describedby={describedBy()}
                        class="flex flex-wrap gap-1"
                      >
                        <For each={[24, 168, 720]}>
                          {(value) => (
                            <Button
                              aria-describedby={describedBy()}
                              size="sm"
                              variant="subtle"
                              aria-pressed={sensitiveRetentionHours() === value}
                              disabled={!options.canAdmin || value > 8760}
                              class="h-[34px] rounded-[9px]"
                              style={
                                sensitiveRetentionHours() === value
                                  ? {
                                      color: "var(--k2b-action)",
                                      background: "var(--k2b-selected)",
                                      "box-shadow": "inset 0 0 0 1.5px color-mix(in srgb, var(--k2b-action) 40%, transparent)",
                                    }
                                  : undefined
                              }
                              onClick={() => setSensitiveRetentionHours(value)}
                            >
                              {new Intl.NumberFormat(locale()).format(value)} {t().hours}
                            </Button>
                          )}
                        </For>
                      </div>
                      <div class="w-full max-w-[280px]">
                        <NumberInput
                          aria-label={t().sensitiveEventRetention}
                          aria-describedby={describedBy()}
                          icon="ti ti-shield-lock"
                          suffix={t().hours}
                          min={1}
                          max={8760}
                          disabled={!options.canAdmin}
                          value={sensitiveRetentionHours}
                          onValueChange={setSensitiveRetentionHours}
                          required
                        />
                      </div>
                    </div>
                  )}
                </SettingsField>
              </div>
              <SettingsModal.Footer>
                <SettingsPanelFooter
                  changeCount={changeCount}
                  loading={options.loading}
                  onDiscard={discard}
                  onSave={() => options.canAdmin && void saveSettings()}
                />
              </SettingsModal.Footer>
            </SettingsModal.Tab>

            <SettingsModal.Tab id="usage" title={t().settingsUsage} icon="ti ti-gauge">
              <div class="mb-6 grid max-w-[860px] grid-cols-1 gap-6 @min-[760px]/k2b-app-area:grid-cols-3">
                <div>
                  <p class="text-[13px] text-dimmed">{storeT().usage}</p>
                  <Show when={store().usage} fallback={<p class="mt-2 text-sm text-secondary">{storeT().notMeasured}</p>}>
                    {(measured) => (
                      <>
                        <p class="mt-0.5 mb-2 text-[22px] font-semibold tabular-nums">
                          {text.pprintBytes(measured().bytes, { locale: locale(), mode: "si" })}{" "}
                          <span class="text-[13px] font-medium text-dimmed">
                            / {text.pprintBytes(store().limits.storageBytes, { locale: locale(), mode: "si" })}
                          </span>
                        </p>
                        <ProgressBar
                          value={(measured().bytes / store().limits.storageBytes) * 100}
                          label={storeT().usageOf({
                            used: text.pprintBytes(measured().bytes, { locale: locale(), mode: "si" }),
                            limit: text.pprintBytes(store().limits.storageBytes, { locale: locale(), mode: "si" }),
                          })}
                          size="xs"
                        />
                        <p class="mt-1 text-xs text-dimmed">
                          {storeT().measured} <Format.RelativeTime value={measured().measuredAt} />
                        </p>
                      </>
                    )}
                  </Show>
                </div>
                <div>
                  <p class="text-[13px] text-dimmed">{t().settingsValuesPerMinute}</p>
                  <p class="mt-0.5 text-[22px] font-semibold tabular-nums">
                    {new Intl.NumberFormat(locale()).format(store().limits.valuesPerMinute)}
                  </p>
                  <p class="text-xs text-dimmed">{t().settingsRateLimitOnly}</p>
                </div>
                <div>
                  <p class="text-[13px] text-dimmed">{t().settingsQueriesPerHour}</p>
                  <Show
                    when={!usage.error() && usage.data()}
                    fallback={
                      <Show
                        when={usage.loading() && !usage.error()}
                        fallback={<p class="mt-2 text-sm text-secondary">{t().settingsUsageFailed}</p>}
                      >
                        <Skeleton class="mt-2 h-7 w-32" />
                        <Skeleton class="mt-2 h-1 w-full" />
                      </Show>
                    }
                  >
                    {(limits) => (
                      <>
                        <p class="mt-0.5 mb-2 text-[22px] font-semibold tabular-nums">
                          {new Intl.NumberFormat(locale()).format(limits().queriesUsed)}{" "}
                          <span class="text-[13px] font-medium text-dimmed">
                            / {new Intl.NumberFormat(locale()).format(limits().queriesPerHour)}
                          </span>
                        </p>
                        <ProgressBar
                          value={(limits().queriesUsed / limits().queriesPerHour) * 100}
                          label={t().settingsQueriesPerHour}
                          size="xs"
                        />
                      </>
                    )}
                  </Show>
                </div>
              </div>
              <StoreStatusGroup store={store} busy={retrying} onRetry={() => options.canAdmin && void retry()} />
              <SettingsGroup title={t().settingsSqlLimits}>
                <div class="min-h-48">
                  <Show when={usage.error()}>
                    <Placeholder
                      state="error"
                      align="left"
                      title={t().settingsSqlFailed}
                      description={t().settingsSqlRetryHelp}
                      onRetry={() => void usage.refresh()}
                    />
                  </Show>
                  <Show when={usage.loading() && !usage.error()}>
                    <p role="status" class="sr-only">
                      {t().settingsSqlLoading}
                    </p>
                    <div class="flex flex-col gap-4 py-2">
                      <Skeleton class="h-4 w-3/4" />
                      <Skeleton class="h-4 w-full" />
                      <Skeleton class="h-4 w-2/3" />
                      <Skeleton class="h-4 w-1/2" />
                    </div>
                  </Show>
                  <Show when={!usage.loading() && !usage.error() && usage.data()}>
                    {(limits) => (
                      <DescriptionList
                        layout="rows"
                        items={[
                          { term: t().settingsSqlInput, description: "16 KiB · 32 × 2 KiB" },
                          {
                            term: t().settingsSqlLimits,
                            description: `${{ small: storeT().profileSmall, normal: storeT().profileNormal, large: storeT().profileLarge }[limits().profile]} · ${limits().memoryBytes / 1e9} GB · ${limits().timeSeconds} s · ${limits().maxRows} · 4 MiB`,
                          },
                          {
                            term: t().settingsSqlConcurrency,
                            description: `${limits().baseSlots} / ${limits().cloudSlots} · ${limits().maxWaiting} · ${limits().waitMs / 1000} s`,
                          },
                          { term: t().settingsQueriesPerHour, description: `${limits().queriesUsed} / ${limits().queriesPerHour}` },
                        ]}
                      />
                    )}
                  </Show>
                </div>
                <p class="text-xs text-secondary">{t().settingsOnlyCloudAdmin}</p>
              </SettingsGroup>
            </SettingsModal.Tab>
            <SettingsModal.Tab
              id="danger"
              title={t().settingsDanger}
              icon="ti ti-alert-triangle"
              tone="danger"
              description={t().destructiveBaseActions}
            >
              <SettingsGroup
                title={t().clearTelemetry}
                description={clearBlocked() ? storeT().clearBlockedText : t().clearTelemetryDescription}
              >
                <SettingsGroup.Action>
                  <Button
                    type="button"
                    variant="ghost"
                    class="text-(--k2b-danger-text)!"
                    size="sm"
                    disabled={!options.canAdmin || options.loading() || options.writeBlocked() || clearBlocked()}
                    onClick={() => void options.clearBaseData()}
                  >
                    <i class="ti ti-eraser text-sm" />
                    {t().clearTelemetry}
                  </Button>
                </SettingsGroup.Action>
              </SettingsGroup>
              <SettingsGroup title={t().deletePulseBase} description={t().deletePulseBaseDescription}>
                <SettingsGroup.Action>
                  <Button
                    type="button"
                    variant="ghost"
                    class="text-(--k2b-danger-text)!"
                    size="sm"
                    disabled={!options.canAdmin || options.loading() || options.writeBlocked()}
                    onClick={() => void options.deleteBase().then((deleted) => deleted && close())}
                  >
                    <i class="ti ti-trash text-sm" />
                    {t().deletePulseBase}
                  </Button>
                </SettingsGroup.Action>
              </SettingsGroup>
            </SettingsModal.Tab>
          </SettingsModal>
        </div>
      );
    },
    { surface: "bare", header: false, size: "wide", history: false, signal: options.signal },
  );
