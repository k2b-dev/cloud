import { text } from "@k2b/stdlib";
import {
  Button,
  DataTable,
  type DataTableColumn,
  DescriptionList,
  Format,
  NoticeCard,
  NumberInput,
  Placeholder,
  prompts,
  Select,
  StatusBadge,
  toast,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type {
  AdminBaseRow,
  AdminBasesPage,
  BaseCreationPolicy,
  BaseLimits,
  BaseStoreStatus,
  InstanceDisk,
  OrphanDatabase,
  PulsePolicy,
  ReadProfileName,
} from "../../store/admin-contracts";
import { AdminClientError, adminClient } from "./admin-client";
import { adminErrorText, type PulseAdminMessages, pulseAdminMessages } from "./pulse-admin-messages";

const PAGE_SIZE = 50;
const MIB = 1024 * 1024;
const GB = 1_000_000_000;

const codeOf = (cause: unknown) => (cause instanceof AdminClientError ? cause.code : "ADMIN_REQUEST_FAILED");
const bytes = (value: number, locale: string) => text.pprintBytes(value, { locale, mode: "si" });
const number = (value: number, locale: string) => text.pprintNumber(value, { locale });

export const profileLabel = (t: PulseAdminMessages, profile: ReadProfileName) =>
  ({ small: t.profileSmall, normal: t.profileNormal, large: t.profileLarge })[profile];
const profileOptions = (t: PulseAdminMessages) =>
  (["small", "normal", "large"] as const).map((value) => ({
    value,
    label: profileLabel(t, value),
    description: { small: t.profileSmallDescription, normal: t.profileNormalDescription, large: t.profileLargeDescription }[value],
  }));

/** The state a base admin and the Cloud admin see; `null` while the base is active and writable. */
export const storeBadge = (t: PulseAdminMessages, store: BaseStoreStatus) => {
  if (store.state === "active" && store.writeBlockReason) return { tone: "warning" as const, label: t.stateWriteBlocked };
  if (store.state === "active") return null;
  if (store.state === "failed") return { tone: "error" as const, label: t.stateFailed };
  return {
    tone: "running" as const,
    label: { provisioning: t.stateProvisioning, clearing: t.stateClearing, deleting: t.stateDeleting }[store.state],
  };
};
export const failedOperationText = (t: PulseAdminMessages, store: BaseStoreStatus) =>
  store.operation === "clear" ? t.operationClear : store.operation === "delete" ? t.operationDelete : t.operationProvision;

/** Profile and limits of one base, or the starting values for new bases. */
const LimitsFields = (props: {
  t: PulseAdminMessages;
  profile: () => ReadProfileName;
  setProfile: (value: ReadProfileName) => void;
  limits: () => BaseLimits;
  setLimit: (key: keyof BaseLimits, value: number) => void;
  disabled: boolean;
}) => {
  const field = (key: keyof BaseLimits, label: string, scale = 1, suffix?: string, description?: string) => (
    <NumberInput
      label={label}
      description={description}
      min={1}
      value={() => Math.round(props.limits()[key] / scale)}
      onValueChange={(value) => value !== null && props.setLimit(key, value * scale)}
      suffix={suffix}
      required
      disabled={props.disabled}
    />
  );
  return (
    <div class="flex flex-col gap-4">
      <Select
        label={props.t.profile}
        description={props.t.profileDescription}
        value={props.profile}
        onValueChange={(value) => value && props.setProfile(value as ReadProfileName)}
        options={profileOptions(props.t)}
        disabled={props.disabled}
      />
      <div class="grid gap-4 sm:grid-cols-2">
        {field("storageBytes", props.t.storageLimit, GB, props.t.gb, props.t.storageLimitDescription)}
        {field("valuesPerMinute", props.t.valuesPerMinute, 1, undefined, props.t.valuesPerMinuteDescription)}
        {field("bytesPerMinute", props.t.bytesPerMinute, MIB, props.t.mib)}
        {field("maxSeries", props.t.maxSeries)}
        {field("maxEventKinds", props.t.maxEventKinds)}
        {field("maxStateKeys", props.t.maxStateKeys)}
      </div>
    </div>
  );
};

/** Dialog footer with a fixed place for the error line, so nothing moves when a save fails. */
const DialogActions = (props: { t: PulseAdminMessages; busy: boolean; error: string; onCancel: () => void }) => (
  <div class="flex flex-col gap-2">
    <p class="min-h-5 text-sm text-danger" role="alert">
      {props.error}
    </p>
    <div class="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="ghost" disabled={props.busy} onClick={props.onCancel}>
        {props.t.cancel}
      </Button>
      <Button type="submit" variant="primary" loading={props.busy}>
        {props.t.save}
      </Button>
    </div>
  </div>
);

const openDefaultsDialog = (t: PulseAdminMessages, policy: PulsePolicy, signal: AbortSignal) =>
  prompts.dialog<PulsePolicy>(
    (close, context) => {
      const [profile, setProfile] = createSignal(policy.defaultProfile);
      const [limits, setLimits] = createSignal(policy.defaultLimits);
      const [maxBases, setMaxBases] = createSignal<number | null>(policy.maxBases);
      const [maxRaw, setMaxRaw] = createSignal<number | null>(policy.maxRawRetentionDays);
      const [busy, setBusy] = createSignal(false);
      const [error, setError] = createSignal("");
      context.setDismissHandler(() => {
        if (!busy()) close();
      });
      const submit = async () => {
        if (busy()) return;
        setBusy(true);
        setError("");
        try {
          close(
            await adminClient.savePolicy(
              {
                defaultProfile: profile(),
                defaultLimits: limits(),
                maxBases: maxBases() ?? policy.maxBases,
                maxRawRetentionDays: maxRaw() ?? policy.maxRawRetentionDays,
              },
              signal,
            ),
          );
        } catch (cause) {
          if (!signal.aborted) setError(adminErrorText(t, codeOf(cause)));
        } finally {
          setBusy(false);
        }
      };
      return (
        <form
          class="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p class="text-sm text-secondary">{t.defaultsDialogIntro}</p>
          <div class="grid gap-4 sm:grid-cols-2">
            <NumberInput
              label={t.maxBases}
              description={t.maxBasesDescription}
              min={1}
              max={100_000}
              value={maxBases}
              onValueChange={setMaxBases}
              required
              disabled={busy()}
            />
            <NumberInput
              label={t.maxRawRetention}
              description={t.maxRawRetentionDescription}
              min={1}
              max={3650}
              suffix={t.days}
              value={maxRaw}
              onValueChange={setMaxRaw}
              required
              disabled={busy()}
            />
          </div>
          <LimitsFields
            t={t}
            profile={profile}
            setProfile={setProfile}
            limits={limits}
            setLimit={(key, value) => setLimits({ ...limits(), [key]: value })}
            disabled={busy()}
          />
          <DialogActions t={t} busy={busy()} error={error()} onCancel={() => close()} />
        </form>
      );
    },
    { title: t.defaultsDialogTitle, icon: "ti ti-adjustments", size: "medium" },
  );

type BaseAction = "retry" | "recheck" | "recreate";
/** Limits of one base; also the place where a phone reaches the state actions of its row. */
const openLimitsDialog = (
  t: PulseAdminMessages,
  row: AdminBaseRow,
  locale: string,
  signal: AbortSignal,
  onAction: (action: BaseAction) => void,
) =>
  prompts.dialog<AdminBaseRow>(
    (close, context) => {
      const [profile, setProfile] = createSignal(row.store.profile);
      const [limits, setLimits] = createSignal(row.store.limits);
      const [busy, setBusy] = createSignal(false);
      const [error, setError] = createSignal("");
      context.setDismissHandler(() => {
        if (!busy()) close();
      });
      const submit = async () => {
        if (busy()) return;
        setBusy(true);
        setError("");
        try {
          close(await adminClient.saveLimits(row.id, { profile: profile(), limits: limits() }, signal));
        } catch (cause) {
          if (!signal.aborted) setError(adminErrorText(t, codeOf(cause)));
        } finally {
          setBusy(false);
        }
      };
      return (
        <form
          class="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Show when={row.store.state === "failed"}>
            <NoticeCard
              tone="danger"
              title={t.stateFailed}
              detail={failedOperationText(t, row.store)}
              meta={row.store.errorCode ?? undefined}
            >
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  close();
                  onAction("retry");
                }}
              >
                {t.retry}
              </Button>
            </NoticeCard>
          </Show>
          <Show when={row.store.state === "active" && row.store.writeBlockReason}>
            <NoticeCard
              tone="warning"
              title={t.stateWriteBlocked}
              detail={row.store.writeBlockReason === "database_missing" ? t.blockedMissing : t.blockedMismatch}
            >
              <span class="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    close();
                    onAction("recheck");
                  }}
                >
                  {t.recheck}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    close();
                    onAction("recreate");
                  }}
                >
                  {t.recreate}
                </Button>
              </span>
            </NoticeCard>
          </Show>
          <div class="flex flex-col gap-1">
            <p class="text-sm text-secondary">{t.limitsIntro}</p>
            <Show when={row.store.usage}>
              {(usage) => (
                <p class="text-xs text-dimmed">
                  {t.usageNow({ used: bytes(usage().bytes, locale) })} <Format.RelativeTime value={usage().measuredAt} />
                </p>
              )}
            </Show>
          </div>
          <LimitsFields
            t={t}
            profile={profile}
            setProfile={setProfile}
            limits={limits}
            setLimit={(key, value) => setLimits({ ...limits(), [key]: value })}
            disabled={busy()}
          />
          <DialogActions t={t} busy={busy()} error={error()} onCancel={() => close()} />
        </form>
      );
    },
    { title: t.limitsTitle({ name: row.name }), icon: "ti ti-gauge", size: "medium" },
  );

/** Orphaned databases come from ClickHouse, so the browser reads them after the page is shown. */
const Orphans = (props: { t: PulseAdminMessages; signal: AbortSignal }) => {
  type View = { kind: "loading" } | { kind: "error" } | { kind: "ready"; items: OrphanDatabase[]; nextCursor: string | null };
  const [view, setView] = createSignal<View>({ kind: "loading" });
  const [busy, setBusy] = createSignal<string | null>(null);
  const load = async () => {
    setView({ kind: "loading" });
    try {
      const page = await adminClient.orphans({ limit: PAGE_SIZE }, props.signal);
      setView({ kind: "ready", items: page.items, nextCursor: page.nextCursor });
    } catch {
      if (!props.signal.aborted) setView({ kind: "error" });
    }
  };
  const more = async () => {
    const current = view();
    if (current.kind !== "ready" || current.nextCursor === null) return;
    try {
      const page = await adminClient.orphans({ limit: PAGE_SIZE, after: current.nextCursor }, props.signal);
      setView({ kind: "ready", items: [...current.items, ...page.items], nextCursor: page.nextCursor });
    } catch (cause) {
      if (!props.signal.aborted) toast.error(adminErrorText(props.t, codeOf(cause)));
    }
  };
  const remove = async (database: string) => {
    const confirmed = await prompts.confirm(props.t.deleteOrphanText, {
      title: props.t.deleteOrphanTitle({ database }),
      confirmText: props.t.delete,
      variant: "danger",
      icon: "ti ti-trash",
    });
    if (!confirmed) return;
    setBusy(database);
    try {
      await adminClient.deleteOrphan(database, props.signal);
      const current = view();
      if (current.kind === "ready") setView({ ...current, items: current.items.filter((item) => item.database !== database) });
    } catch (cause) {
      if (!props.signal.aborted) toast.error(adminErrorText(props.t, codeOf(cause)));
    } finally {
      setBusy(null);
    }
  };
  onMount(() => void load());
  return (
    <section class="flex flex-col gap-2" aria-labelledby="pulse-orphans" aria-busy={view().kind === "loading"}>
      <div>
        <h2 id="pulse-orphans" class="text-sm font-semibold text-primary">
          {props.t.orphansTitle}
        </h2>
        <p class="mt-1 text-xs text-dimmed">{props.t.orphansDescription}</p>
      </div>
      {/* Last on the page: the list can grow without moving anything above it. */}
      <Show when={view().kind === "loading"}>
        <Placeholder state="loading" variant="inline" align="left" title={props.t.orphansLoading} />
      </Show>
      <Show when={view().kind === "error"}>
        <Placeholder state="error" variant="inline" align="left" title={props.t.orphansFailed} onRetry={() => void load()} />
      </Show>
      <Show
        when={(() => {
          const current = view();
          return current.kind === "ready" ? current : null;
        })()}
      >
        {(ready) => (
          <Show
            // A bounded scan may end before it found an orphan; "Show more" continues it.
            when={ready().items.length > 0 || ready().nextCursor !== null}
            fallback={<Placeholder variant="inline" align="left" icon="ti ti-circle-check" title={props.t.orphansNone} />}
          >
            <ul class="flex flex-col">
              <For each={ready().items}>
                {(item) => (
                  <li class="flex min-h-11 flex-wrap items-center justify-between gap-2">
                    <span class="flex min-w-0 items-center gap-2">
                      <span class="truncate font-mono text-sm text-primary">{item.database}</span>
                      <StatusBadge class="shrink-0" tone="warning" variant="text" icon="ti ti-unlink" label={props.t.orphanBadge} />
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      loading={busy() === item.database}
                      disabled={busy() !== null}
                      onClick={() => void remove(item.database)}
                    >
                      {props.t.delete}
                    </Button>
                  </li>
                )}
              </For>
            </ul>
            <Show when={ready().nextCursor !== null}>
              <div>
                <Button size="sm" variant="ghost" onClick={() => void more()}>
                  {props.t.loadMore}
                </Button>
              </div>
            </Show>
          </Show>
        )}
      </Show>
    </section>
  );
};

export default function BasesAdmin(props: { initialPolicy: PulsePolicy | null; initialPage: AdminBasesPage | null }) {
  const locale = useLocale();
  const t = createMemo(() => pulseAdminMessages.resolve([locale()]).t);
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  const [policy, setPolicy] = createSignal(props.initialPolicy);
  const [rows, setRows] = createSignal<AdminBaseRow[]>(props.initialPage?.items ?? []);
  const [total, setTotal] = createSignal(props.initialPage?.total ?? 0);
  const [nextOffset, setNextOffset] = createSignal(props.initialPage?.nextOffset ?? null);
  const [disk, setDisk] = createSignal<InstanceDisk | null>(props.initialPage?.disk ?? null);
  const [used, setUsed] = createSignal(props.initialPage?.usedBytes ?? 0);
  const [loadFailed, setLoadFailed] = createSignal(!props.initialPage || !props.initialPolicy);
  const [loading, setLoading] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [policyBusy, setPolicyBusy] = createSignal(false);
  const [rowBusy, setRowBusy] = createSignal<string | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      const [nextPolicy, page] = await Promise.all([
        adminClient.policy(controller.signal),
        adminClient.bases({ limit: PAGE_SIZE }, controller.signal),
      ]);
      setPolicy(nextPolicy);
      setRows(page.items);
      setTotal(page.total);
      setNextOffset(page.nextOffset);
      setUsed(page.usedBytes);
      setDisk(page.disk);
      setLoadFailed(false);
    } catch {
      if (!controller.signal.aborted) setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  };
  const more = async () => {
    const offset = nextOffset();
    if (offset === null || loadingMore()) return;
    setLoadingMore(true);
    try {
      const page = await adminClient.bases({ limit: PAGE_SIZE, offset }, controller.signal);
      const known = new Set(rows().map((row) => row.id));
      setRows([...rows(), ...page.items.filter((row) => !known.has(row.id))]);
      setTotal(page.total);
      setNextOffset(page.nextOffset);
      setUsed(page.usedBytes);
      setDisk(page.disk);
    } catch (cause) {
      if (!controller.signal.aborted) toast.error(adminErrorText(t(), codeOf(cause)));
    } finally {
      setLoadingMore(false);
    }
  };
  const replace = (next: AdminBaseRow) => setRows(rows().map((row) => (row.id === next.id ? next : row)));

  const setCreation = async (value: BaseCreationPolicy) => {
    const current = policy();
    if (!current || value === current.baseCreation || policyBusy()) return;
    setPolicyBusy(true);
    // Show the choice at once; a refusal puts the saved value back.
    setPolicy({ ...current, baseCreation: value });
    try {
      setPolicy(await adminClient.savePolicy({ baseCreation: value }, controller.signal));
      toast.success(t().saved);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setPolicy(current);
      toast.error(adminErrorText(t(), codeOf(cause)));
    } finally {
      setPolicyBusy(false);
    }
  };
  const editDefaults = async () => {
    const current = policy();
    if (!current) return;
    const next = await openDefaultsDialog(t(), current, controller.signal);
    if (next) {
      setPolicy(next);
      toast.success(t().saved);
    }
  };
  const editLimits = async (row: AdminBaseRow) => {
    const next = await openLimitsDialog(t(), row, locale(), controller.signal, (action) => void act(row, action));
    if (next) {
      replace(next);
      toast.success(t().saved);
    }
  };
  const act = async (row: AdminBaseRow, action: BaseAction) => {
    if (rowBusy()) return;
    if (action === "recreate") {
      const confirmed = await prompts.confirm(t().recreateConfirmText, {
        title: t().recreateConfirmTitle({ name: row.name }),
        confirmText: t().recreate,
        variant: "danger",
        icon: "ti ti-database-off",
      });
      if (!confirmed) return;
    }
    setRowBusy(row.id);
    try {
      replace(await adminClient.baseAction(row.id, action, controller.signal));
      if (action === "retry") toast.success(t().retryStarted);
    } catch (cause) {
      if (!controller.signal.aborted) toast.error(adminErrorText(t(), codeOf(cause)));
    } finally {
      setRowBusy(null);
    }
  };

  const creationOptions = () => [
    { value: "everyone", label: t().creationEveryone },
    { value: "people", label: t().creationPeople },
    { value: "admins", label: t().creationAdmins },
  ];
  const defaultsSummary = () => {
    const current = policy();
    if (!current) return "";
    return t().defaultsSummary({
      storage: bytes(current.defaultLimits.storageBytes, locale()),
      values: number(current.defaultLimits.valuesPerMinute, locale()),
      profile: profileLabel(t(), current.defaultProfile).toLowerCase(),
      maxRaw: number(current.maxRawRetentionDays, locale()),
      maxBases: number(current.maxBases, locale()),
    });
  };
  const subtitle = () => {
    const free = disk();
    return free
      ? t().basesSubtitle({ count: total(), used: bytes(used(), locale()), free: bytes(free.freeBytes, locale()) })
      : t().basesSubtitleNoDisk({ count: total(), used: bytes(used(), locale()) });
  };
  const blocked = () => rows().filter((row) => row.store.state === "active" && row.store.writeBlockReason);

  const columns = (): DataTableColumn<AdminBaseRow>[] => [
    { id: "base", header: t().colBase, value: "name" },
    { id: "admins", header: t().colAdmins, value: (row) => row.admins.join(", "), class: "max-sm:hidden" },
    { id: "storage", header: t().colStorage, align: "right", nowrap: true, value: (row) => row.store.usage?.bytes ?? null },
    {
      id: "values",
      header: t().colValues,
      align: "right",
      nowrap: true,
      value: (row) => row.store.limits.valuesPerMinute,
      class: "max-md:hidden",
    },
    { id: "retention", header: t().colRetention, align: "right", nowrap: true, value: "rawRetentionDays", class: "max-md:hidden" },
    // On a phone the row itself opens the limits dialog, which also carries the state actions.
    { id: "actions", header: <span class="sr-only">{t().colActions}</span>, align: "right", nowrap: true, class: "max-sm:hidden" },
  ];

  return (
    <div class="flex max-w-5xl flex-col gap-6">
      <p class="text-sm text-secondary">{t().basesIntro}</p>
      <Show
        when={!loadFailed() && policy()}
        fallback={
          <Placeholder
            state="error"
            surface="paper"
            title={t().basesLoadFailed}
            description={t().basesLoadFailedDescription}
            onRetry={() => void reload()}
          />
        }
      >
        <DescriptionList
          layout="rows"
          items={[
            {
              term: t().creationTitle,
              description: (
                <div class="flex max-w-sm flex-col gap-1">
                  <Select
                    aria-label={t().creationTitle}
                    value={() => policy()?.baseCreation ?? "everyone"}
                    onValueChange={(value) => value && void setCreation(value as BaseCreationPolicy)}
                    options={creationOptions()}
                    disabled={policyBusy()}
                  />
                  <span class="text-xs text-dimmed">{t().creationDescription}</span>
                </div>
              ),
            },
            {
              term: t().defaultsTitle,
              description: (
                <div class="flex flex-col gap-1">
                  <span class="text-sm text-primary">{defaultsSummary()}</span>
                  <span class="text-xs text-dimmed">{t().defaultsDescription}</span>
                </div>
              ),
              action: (
                <Button size="xs" variant="ghost" onClick={() => void editDefaults()}>
                  {t().editDefaults}
                </Button>
              ),
            },
          ]}
        />

        <Show when={blocked().length > 0}>
          <NoticeCard tone="warning" title={t().blockedTitle({ count: blocked().length })} detail={t().blockedHelp}>
            <ul class="flex flex-col gap-2">
              <For each={blocked()}>
                {(row) => (
                  <li class="flex flex-wrap items-center justify-between gap-2">
                    <span class="min-w-0">
                      <span class="font-medium text-primary">{row.name}</span>
                      <span class="text-secondary">
                        {" · "}
                        {row.store.writeBlockReason === "database_missing" ? t().blockedMissing : t().blockedMismatch}
                      </span>
                    </span>
                    <span class="flex gap-2">
                      <Button size="xs" variant="secondary" disabled={rowBusy() !== null} onClick={() => void act(row, "recheck")}>
                        {t().recheck}
                      </Button>
                      <Button size="xs" variant="ghost" disabled={rowBusy() !== null} onClick={() => void act(row, "recreate")}>
                        {t().recreate}
                      </Button>
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </NoticeCard>
        </Show>

        <DataTable.Panel>
          <DataTable.Header title={t().basesTitle} subtitle={subtitle()} as="h2" />
          <DataTable
            rows={rows()}
            columns={columns()}
            getRowId={(row) => row.id}
            surface="plain"
            stickyHeader={false}
            loading={loading()}
            hasMore={nextOffset() !== null}
            loadingMore={loadingMore()}
            onLoadMore={() => void more()}
            onRowClick={(row) => row.store.state !== "deleting" && void editLimits(row)}
            empty={<Placeholder title={t().basesEmpty} description={t().basesEmptyDescription} icon="ti ti-database" />}
            renderCell={({ row, col, render }) => {
              const badge = () => storeBadge(t(), row.store);
              if (col.id === "base")
                return (
                  <span class="flex min-w-0 items-center gap-2">
                    <span class="truncate font-medium text-primary">{row.name}</span>
                    <Show when={badge()}>
                      {(value) => (
                        <StatusBadge tone={value().tone} variant="text" label={value().label} title={row.store.errorCode ?? undefined} />
                      )}
                    </Show>
                  </span>
                );
              if (col.id === "admins")
                return (
                  <span class="truncate text-secondary">
                    {row.admins.length ? row.admins.join(", ") : t().noAdmins}
                    <Show when={row.adminCount > row.admins.length}> {t().adminsMore({ count: row.adminCount - row.admins.length })}</Show>
                  </span>
                );
              if (col.id === "storage")
                return (
                  <span class="tabular-nums">
                    {row.store.usage
                      ? t().storageOf({
                          used: bytes(row.store.usage.bytes, locale()),
                          limit: bytes(row.store.limits.storageBytes, locale()),
                        })
                      : t().notMeasured}
                  </span>
                );
              if (col.id === "values") return <span class="tabular-nums">{number(row.store.limits.valuesPerMinute, locale())}</span>;
              if (col.id === "retention")
                return (
                  <span class="tabular-nums">
                    {t().retentionOf({ days: row.rawRetentionDays, max: policy()?.maxRawRetentionDays ?? row.rawRetentionDays })}
                  </span>
                );
              if (col.id === "actions")
                return (
                  // DataTable ignores row clicks from nested controls, so these never open the dialog twice.
                  <span class="flex justify-end gap-1">
                    <Show when={row.store.state === "failed"}>
                      <Button
                        size="xs"
                        variant="secondary"
                        loading={rowBusy() === row.id}
                        disabled={rowBusy() !== null}
                        title={failedOperationText(t(), row.store)}
                        onClick={() => void act(row, "retry")}
                      >
                        {t().retry}
                      </Button>
                    </Show>
                    <Button size="xs" variant="ghost" disabled={row.store.state === "deleting"} onClick={() => void editLimits(row)}>
                      {t().limits}
                    </Button>
                  </span>
                );
              return render(undefined);
            }}
          />
        </DataTable.Panel>
        <p class="text-xs text-dimmed">{t().amountsOnly}</p>
      </Show>
      <Orphans t={t()} signal={controller.signal} />
    </div>
  );
}
