import { openAccessDialog, principalLabel } from "@k2b/cloud/access/ui";
import type { AccessEntry, Principal } from "@k2b/cloud/contracts";
import V2WorkspaceNavigation from "@k2b/cloud/ssr/V2WorkspaceNavigation";
import { navigateTo } from "@k2b/ssr/nav";
import { text } from "@k2b/stdlib";
import { DEFAULT_ICON_OPTIONS, useLocale } from "@k2b/ui";
import {
  Band,
  Bar,
  Button,
  Cells,
  Choice,
  Dialog,
  Empty,
  Facts,
  Failed,
  Field,
  Input,
  List,
  Nav,
  type NavGroup,
  Notice,
  Pane,
  Path,
  Row,
  Section,
  Select,
  Tabs,
  useToast,
  Workspace,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { BASE_COLORS } from "../../base-settings";
import type { PulseBase } from "../../contracts";
import type { SqlLimits } from "../../service/sql-service";
import { jsonFetch } from "../http";
import { usePulseMessages } from "../use-messages";
import { type BaseSettingsInput, createBaseController } from "../workspace/base-controller";
import { baseStoreMessages } from "../workspace/base-store-messages";
import { installPeriodicRefresh } from "../workspace/periodic-refresh";
import type { PulseSettingsTab } from "../workspace/routes";
import { baseHref, iconName } from "./BaseFrame";
import { useScreenMessages } from "./messages";
import { storeState } from "./store-state";

export type SettingsScreenProps = {
  bases: PulseBase[];
  base: PulseBase;
  tab: PulseSettingsTab;
  canAdmin: boolean;
  /** Up to three people who administer the base, named to everyone else. */
  admins: string[];
  maxRawRetentionDays: number;
  /** On "members" for admins: who has access; null when it could not be read. */
  access: AccessEntry[] | null;
  /** On "usage": the base's SQL limits and this hour's queries; null when they could not be read. */
  limits: SqlLimits | null;
};

const settingsHref = (baseId: string, tab: PulseSettingsTab) => `${baseHref(baseId, "settings")}${tab === "general" ? "" : `/${tab}`}`;

/**
 * The settings of one base as a page of its own: the areas as tabs, each a form or a few facts. Only base admins
 * change anything; everyone else reads and sees who administers the base.
 */
export default function SettingsScreen(props: SettingsScreenProps) {
  const t = usePulseMessages();
  const words = useScreenMessages();
  const locale = useLocale();
  const store = () => baseStoreMessages.resolve([locale()]).t;
  const toast = useToast();
  const [base, setBase] = createSignal(props.base);
  const [loading, setLoading] = createSignal(false);
  const [refreshFailed, setRefreshFailed] = createSignal(false);
  const refreshBase = async () => {
    try {
      setBase(await jsonFetch<PulseBase>(`/api/pulse/bases/${props.base.id}`));
      setRefreshFailed(false);
    } catch (error) {
      setRefreshFailed(true);
      throw error;
    }
  };
  const controller = createBaseController({
    loading,
    setLoading,
    notify: (message, status) => toast(message, { status }),
    confirm: (question) => Dialog.confirm({ ...question, cancel: words().cancel }),
    refreshBase,
    writeBlocked: () => refreshFailed(),
    leave: () => navigateTo("/app/pulse"),
  });
  // A running provision, clear or delete ends in active or failed; the page shows that end without a reload.
  installPeriodicRefresh({
    active: () => ["provisioning", "clearing", "deleting"].includes(base().store.state),
    refresh: refreshBase,
  });

  const groups = (): NavGroup[] => [
    { items: [{ label: words().allBases, icon: "layout-grid", href: "/app/pulse" }] },
    {
      label: words().bases,
      items: props.bases.map((entry) => ({ label: entry.name, icon: iconName(entry.icon), href: baseHref(entry.id), current: entry.id === props.base.id })),
    },
  ];
  const tabs = () =>
    (
      [
        ["general", t().general, "settings"],
        ["members", t().settingsMembers, "users"],
        ["retention", t().retention, "clock-cog"],
        ["usage", t().settingsUsage, "gauge"],
        ["danger", t().settingsDanger, "alert-triangle"],
      ] as const
    ).map(([id, label, icon]) => ({ label, icon, href: settingsHref(props.base.id, id), current: props.tab === id }));

  return (
    <>
      <V2WorkspaceNavigation label={t().appName} groups={groups()} />
      <Workspace
        sidebar={<Nav title={t().appName} icon="activity-heartbeat" groups={groups()} />}
        sidebarLabel={words().bases}
        head={
          <Bar
            start={
              <Path
                label={words().settingsTabs}
                items={[{ label: base().name, href: baseHref(props.base.id) }, { label: words().settings }]}
              />
            }
          />
        }
      >
        <Pane label={words().settingsTitle({ base: base().name })} head={<Tabs label={words().settingsTabs} items={tabs()} />} scrollKey="pulse-settings">
          <Show when={!props.canAdmin}>
            <Notice tone="note" icon="lock" title={t().settingsNotAdmin}>
              {props.admins.join(", ")}
            </Notice>
          </Show>
          <Show when={refreshFailed()}>
            <Notice tone="bad" icon="alert-circle" title={t().pulseDataRefreshFailed} actions={[{ label: words().reload, icon: "refresh", onClick: () => void refreshBase().catch(() => undefined) }]}>
              {t().refreshBeforeChanges}
            </Notice>
          </Show>
          <Show when={props.tab === "general" || props.tab === "retention"}>
            <BaseForm
              base={base()}
              tab={props.tab === "retention" ? "retention" : "general"}
              canAdmin={props.canAdmin}
              maxRawRetentionDays={props.maxRawRetentionDays}
              loading={loading()}
              save={(input) => controller.updateSettings(base(), input)}
            />
          </Show>
          <Show when={props.tab === "members"}>
            <Members base={base()} canAdmin={props.canAdmin} initial={props.access} refreshBase={refreshBase} />
          </Show>
          <Show when={props.tab === "usage"}>
            <Usage base={base()} limits={props.limits} canAdmin={props.canAdmin} busy={loading()} retry={() => void controller.retryStore(base()).then((next) => next && setBase(next))} />
          </Show>
          <Show when={props.tab === "danger"}>
            <Section icon="alert-triangle" title={t().settingsDanger} summary={t().destructiveBaseActions}>
              <List label={t().settingsDanger}>
                <Row
                  icon="eraser"
                  lines={[t().clearTelemetry, base().store.writeBlockReason ? store().clearBlockedText : t().clearTelemetryDescription]}
                  action={{
                    label: t().clearTelemetry,
                    icon: "eraser",
                    disabled: !props.canAdmin || loading() || Boolean(base().store.writeBlockReason),
                    onClick: () => void controller.clearData(base()),
                  }}
                />
                <Row
                  icon="trash"
                  lines={[t().deletePulseBase, t().deletePulseBaseDescription]}
                  action={{ label: t().deletePulseBase, icon: "trash", disabled: !props.canAdmin || loading(), onClick: () => void controller.deleteBase(base()) }}
                />
              </List>
            </Section>
          </Show>
        </Pane>
      </Workspace>
    </>
  );
}

const RAW_PRESETS = [7, 30, 90, 400, 730, 1095];
const ROLLUP_PRESETS = [365, 800, 1095, 3650];
const SENSITIVE_PRESETS = [24, 168, 720];

/** The base's own fields (general) or its retention, with one "Save" at the end that keeps both tabs' values. */
function BaseForm(props: {
  base: PulseBase;
  tab: "general" | "retention";
  canAdmin: boolean;
  maxRawRetentionDays: number;
  loading: boolean;
  save: (input: BaseSettingsInput) => Promise<"failed" | "persisted">;
}) {
  const t = usePulseMessages();
  const words = useScreenMessages();
  const locale = useLocale();
  const initial = (): BaseSettingsInput => ({
    name: props.base.name,
    icon: props.base.icon,
    color: props.base.color,
    timezone: props.base.timezone,
    description: props.base.description ?? "",
    rawRetentionDays: props.base.rawRetentionDays,
    rollupRetentionDays: props.base.rollupRetentionDays,
    sensitiveRetentionHours: props.base.sensitiveRetentionHours,
  });
  const [saved, setSaved] = createSignal(initial());
  const [draft, setDraft] = createSignal(initial());
  const set = <K extends keyof BaseSettingsInput>(key: K, value: BaseSettingsInput[K]) => setDraft({ ...draft(), [key]: value });
  const changed = createMemo(() => (Object.keys(draft()) as (keyof BaseSettingsInput)[]).some((key) => draft()[key] !== saved()[key]));
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const colorLabel = (value: (typeof BASE_COLORS)[number]) =>
    ({ zinc: t().settingsColorGray, blue: t().settingsColorBlue, emerald: t().settingsColorGreen, amber: t().settingsColorAmber, red: t().settingsColorRed })[value];
  const save = async () => {
    const next = draft();
    if ((await props.save(next)) === "persisted") setSaved(next);
  };
  const retention = (options: { name: keyof BaseSettingsInput; label: string; hint: string; presets: number[]; max: number; unit: string }) => {
    const value = () => Number(draft()[options.name]);
    return (
      <Band>
        <Field name={options.name} label={options.label} hint={options.hint} optional={options.unit}>
          <Choice
            name={`${options.name}-preset`}
            options={options.presets.filter((preset) => preset <= options.max).map((preset) => ({ value: String(preset), label: `${number(preset)} ${options.unit}` }))}
            value={String(value())}
            disabled={!props.canAdmin}
            onChange={(next) => set(options.name, Number(next))}
          />
        </Field>
        <Field name={`${options.name}-exact`} label={options.label} optional={options.unit} error={value() >= 1 && value() <= options.max ? undefined : `1 – ${number(options.max)}`}>
          <Input type="number" min={1} max={options.max} value={String(value())} disabled={!props.canAdmin} onInput={(next) => set(options.name, Number(next))} />
        </Field>
      </Band>
    );
  };
  return (
    <>
      <Show
        when={props.tab === "general"}
        fallback={
          <>
            {retention({ name: "rawRetentionDays", label: t().rawDataRetention, hint: t().rawDataRetentionDescription, presets: RAW_PRESETS, max: props.maxRawRetentionDays, unit: t().days })}
            {retention({ name: "rollupRetentionDays", label: t().hourlyRollupRetention, hint: t().hourlyRollupRetentionDescription, presets: ROLLUP_PRESETS, max: 3650, unit: t().days })}
            {retention({ name: "sensitiveRetentionHours", label: t().sensitiveEventRetention, hint: t().sensitiveEventRetentionDescription, presets: SENSITIVE_PRESETS, max: 8760, unit: t().hours })}
          </>
        }
      >
        <Band>
          <Field name="name" label={t().name} required error={draft().name.trim() ? undefined : t().nameRequired}>
            <Input value={draft().name} disabled={!props.canAdmin} onInput={(value) => set("name", value)} />
          </Field>
          <Field name="color" label={t().settingsColor}>
            <Choice
              name="color"
              options={BASE_COLORS.map((value) => ({ value, label: colorLabel(value) }))}
              value={draft().color}
              disabled={!props.canAdmin}
              onChange={(value) => set("color", value)}
            />
          </Field>
          {/* k2b-ui gap: no icon picker in v2; a selection of the curated icons by name, the field shows the chosen one. */}
          <Field name="icon" label={t().settingsIcon}>
            <Select
              options={DEFAULT_ICON_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
              value={draft().icon}
              onChange={(value) => set("icon", value)}
            />
          </Field>
          <Field name="timezone" label={t().settingsTimezone} hint={t().settingsTimezoneHint}>
            <Input value={draft().timezone} disabled={!props.canAdmin} onInput={(value) => set("timezone", value)} />
          </Field>
          <Field name="description" label={t().description} optional={words().optional}>
            <Input multiline value={draft().description} disabled={!props.canAdmin} onInput={(value) => set("description", value)} />
          </Field>
        </Band>
        <Section icon="id" title={t().settingsIdentifier} summary={t().settingsIdentifierHint}>
          <Facts items={[{ label: t().settingsIdentifier, value: props.base.shortId, mono: true, copy: props.base.shortId }]} />
        </Section>
      </Show>
      <Show when={props.canAdmin}>
        <Bar
          end={
            <>
              <Button disabled={!changed() || props.loading} onClick={() => setDraft(saved())}>
                {words().discard}
              </Button>
              <Button variant="primary" icon="check" busy={props.loading} disabled={!changed()} onClick={() => void save()}>
                {words().save}
              </Button>
            </>
          }
        />
      </Show>
    </>
  );
}

/** Who has access to the base; admins change it in the access dialog, the list reloads once afterwards. */
function Members(props: { base: PulseBase; canAdmin: boolean; initial: AccessEntry[] | null; refreshBase: () => Promise<void> }) {
  const t = usePulseMessages();
  const locale = useLocale();
  const toast = useToast();
  const [entries, setEntries] = createSignal(props.initial);
  const [editing, setEditing] = createSignal(false);
  const owner = new AbortController();
  onCleanup(() => owner.abort());
  const path = `/api/pulse/bases/${props.base.id}/access`;
  const load = async () => {
    try {
      setEntries(await jsonFetch<AccessEntry[]>(path));
    } catch {
      if (!owner.signal.aborted) toast(t().accessChangedRefreshFailed, { status: "bad" });
    }
  };
  const levelWord = (permission: string) => ({ read: t().view, write: t().edit, admin: t().manage })[permission] ?? permission;
  const edit = async () => {
    const current = entries();
    if (!current || editing()) return;
    setEditing(true);
    let wrote = false;
    try {
      // k2b-ui gap: the access dialog of the platform is not on v2 yet; it keeps its behaviour over this page.
      await openAccessDialog({
        target: { type: "pulse.base", id: props.base.id },
        resourceName: props.base.name,
        subtitle: t().accessDialogSubtitle,
        initialEntries: current,
        grantAccess: async (principal: Principal, permission) => {
          const entry = await jsonFetch<AccessEntry>(path, { method: "POST", body: JSON.stringify({ principal, permission }), signal: owner.signal });
          wrote = true;
          return entry;
        },
        updateAccess: async (accessId, permission) => {
          await jsonFetch<void>(`${path}/${accessId}`, { method: "PATCH", body: JSON.stringify({ permission }), signal: owner.signal });
          wrote = true;
        },
        revokeAccess: async (accessId) => {
          await jsonFetch<void>(`${path}/${accessId}`, { method: "DELETE", signal: owner.signal });
          wrote = true;
        },
        allowedLevels: [
          { level: "read", label: t().view, icon: "ti-eye" },
          { level: "write", label: t().edit, icon: "ti-pencil" },
          { level: "admin", label: t().manage, icon: "ti-shield" },
        ],
        signal: owner.signal,
      });
    } finally {
      setEditing(false);
    }
    if (wrote && !owner.signal.aborted) await Promise.all([load(), props.refreshBase().catch(() => undefined)]);
  };
  return (
    <Show when={props.canAdmin} fallback={<Empty icon="users" text={t().accessDescription} />}>
      <Section
        icon="users"
        title={t().peopleAndGroups}
        count={entries()?.length}
        summary={t().peopleAndGroupsDescription}
        actions={[{ label: t().editAccess, icon: "lock-access", disabled: !entries() || editing(), onClick: () => void edit() }]}
      >
        <Show when={entries()} fallback={<Failed text={t().accessLoadFailed} onRetry={() => void load()} />}>
          {(list) => (
            <List label={t().peopleAndGroups}>
              <For each={list()}>
                {(entry) => <Row avatar={{ name: principalLabel(entry, locale()) }} lines={[principalLabel(entry, locale()), levelWord(entry.permission)]} />}
              </For>
            </List>
          )}
        </Show>
      </Section>
    </Show>
  );
}

/** What the base uses against its limits, its store's state with "Retry" in a fixed place, and its SQL limits. */
function Usage(props: { base: PulseBase; limits: SqlLimits | null; canAdmin: boolean; busy: boolean; retry: () => void }) {
  const t = usePulseMessages();
  const locale = useLocale();
  const store = () => baseStoreMessages.resolve([locale()]).t;
  const bytes = (value: number) => text.pprintBytes(value, { locale: locale(), mode: "si" });
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const share = (used: number, limit: number) =>
    t().settingsShareUsed({ share: new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 0 }).format(limit > 0 ? used / limit : 0) });
  const profile = (value: SqlLimits["profile"]) => ({ small: store().profileSmall, normal: store().profileNormal, large: store().profileLarge })[value];
  const state = () => storeState(props.base.store, store());
  const notice = () => {
    const current = props.base.store;
    if (current.state === "failed")
      return { tone: "bad" as const, text: current.operation === "clear" ? store().failedClear : current.operation === "delete" ? store().failedDelete : store().failedProvision, retry: true };
    if (current.state === "active" && current.writeBlockReason) return { tone: "warn" as const, text: store().blockedText, retry: false };
    if (current.state !== "active") return { tone: "note" as const, text: store().busyText, retry: false };
    return null;
  };
  return (
    <>
      <Cells>
        <Cells.Cell
          icon="database"
          label={store().usage}
          value={props.base.store.usage ? `${bytes(props.base.store.usage.bytes)} / ${bytes(props.base.store.limits.storageBytes)}` : store().notMeasured}
          meta={props.base.store.usage ? share(props.base.store.usage.bytes, props.base.store.limits.storageBytes) : undefined}
        />
        <Cells.Cell icon="activity" label={t().settingsValuesPerMinute} value={number(props.base.store.limits.valuesPerMinute)} meta={t().settingsRateLimitOnly} />
        <Cells.Cell
          icon="code"
          label={t().settingsQueriesPerHour}
          value={props.limits ? `${number(props.limits.queriesUsed)} / ${number(props.limits.queriesPerHour)}` : "—"}
          meta={props.limits ? share(props.limits.queriesUsed, props.limits.queriesPerHour) : t().settingsSqlFailed}
        />
      </Cells>
      <Show when={notice()}>
        {(value) => (
          <Notice
            tone={value().tone}
            icon="database"
            title={state().label}
            actions={value().retry ? [{ label: store().retry, icon: "refresh", disabled: !props.canAdmin || props.busy, onClick: props.retry }] : undefined}
          >
            {value().text}
          </Notice>
        )}
      </Show>
      <Section icon="database" title={store().storeTitle} summary={store().storeDescription}>
        <Facts
          items={[
            { label: store().state, value: state().label },
            {
              label: store().limits,
              value: store().limitsSummary({
                values: text.pprintNumber(props.base.store.limits.valuesPerMinute, { locale: locale() }),
                series: text.pprintNumber(props.base.store.limits.maxSeries, { locale: locale() }),
                profile: profile(props.base.store.profile),
              }),
            },
          ]}
        />
      </Section>
      <Section icon="code" title={t().settingsSqlLimits} summary={t().settingsOnlyCloudAdmin}>
        <Show when={props.limits} fallback={<Failed text={t().settingsSqlFailed} onRetry={() => location.reload()} />}>
          {(limits) => (
            <Facts
              items={[
                { label: t().settingsSqlInput, value: "16 KiB · 32 × 2 KiB" },
                {
                  label: t().settingsSqlLimits,
                  value: `${profile(limits().profile)} · ${bytes(limits().memoryBytes)} · ${limits().timeSeconds} s · ${number(limits().maxRows)} · ${bytes(limits().maxResultBytes)}`,
                },
                { label: t().settingsSqlConcurrency, value: `${limits().baseSlots} / ${limits().cloudSlots} · ${limits().maxWaiting} · ${limits().waitMs / 1000} s` },
                { label: t().settingsQueriesPerHour, value: `${limits().queriesUsed} / ${limits().queriesPerHour}` },
              ]}
            />
          )}
        </Show>
      </Section>
    </>
  );
}
