import { text } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import {
  Band,
  Bar,
  Button,
  Chip,
  Dialog,
  Empty,
  Facts,
  Failed,
  Field,
  Input,
  List,
  Loading,
  Menu,
  Notice,
  Pane,
  Row,
  Section,
  Select,
  StatusRow,
  Table,
  Text,
  useToast,
} from "@k2b/ui/v2";
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
import { installPeriodicRefresh } from "../workspace/periodic-refresh";
import { AdminClientError, adminClient } from "./admin-client";
import { adminErrorText, type PulseAdminMessages, pulseAdminMessages } from "./pulse-admin-messages";

const PAGE_SIZE = 50;
const MIB = 1024 * 1024;
const GB = 1_000_000_000;
type BaseAction = "retry" | "recheck" | "recreate";

const codeOf = (cause: unknown) => (cause instanceof AdminClientError ? cause.code : "ADMIN_REQUEST_FAILED");
const bytes = (value: number, locale: string) => text.pprintBytes(value, { locale, mode: "si" });
const number = (value: number, locale: string) => text.pprintNumber(value, { locale });

export const profileLabel = (t: PulseAdminMessages, profile: ReadProfileName) =>
  ({ small: t.profileSmall, normal: t.profileNormal, large: t.profileLarge })[profile];

/** The state a Cloud admin sees; `null` while the base is active and writable. */
export const storeBadge = (
  t: PulseAdminMessages,
  store: BaseStoreStatus,
): { status: "warn" | "bad"; label: string; running: boolean } | null => {
  if (store.state === "active" && store.writeBlockReason) return { status: "warn", label: t.stateWriteBlocked, running: false };
  if (store.state === "active") return null;
  if (store.state === "failed") return { status: "bad", label: t.stateFailed, running: false };
  return {
    status: "warn",
    label: { provisioning: t.stateProvisioning, clearing: t.stateClearing, deleting: t.stateDeleting }[store.state],
    running: true,
  };
};
export const failedOperationText = (t: PulseAdminMessages, store: BaseStoreStatus) =>
  store.operation === "clear" ? t.operationClear : store.operation === "delete" ? t.operationDelete : t.operationProvision;

/** Profile and limits of one base, or the starting values for new bases. */
function LimitsFields(props: {
  t: PulseAdminMessages;
  profile: ReadProfileName;
  setProfile: (value: ReadProfileName) => void;
  limits: BaseLimits;
  setLimit: (key: keyof BaseLimits, value: number) => void;
  disabled: boolean;
}) {
  const field = (key: keyof BaseLimits, label: string, scale = 1, unit?: string, hint?: string) => (
    <Field name={key} label={label} optional={unit} hint={hint} required>
      <Input
        type="number"
        min={1}
        value={String(Math.round(props.limits[key] / scale))}
        disabled={props.disabled}
        onInput={(value) => {
          const next = Number(value);
          if (Number.isFinite(next) && next > 0) props.setLimit(key, next * scale);
        }}
      />
    </Field>
  );
  const profiles = () => (["small", "normal", "large"] as const).map((value) => ({ value, label: profileLabel(props.t, value) }));
  const hint = () =>
    ({ small: props.t.profileSmallDescription, normal: props.t.profileNormalDescription, large: props.t.profileLargeDescription })[
      props.profile
    ];
  return (
    <Band>
      <Field name="profile" label={props.t.profile} hint={`${props.t.profileDescription} ${hint()}`}>
        <Select
          options={profiles()}
          value={props.profile}
          onChange={(value) => props.setProfile(value === "small" || value === "large" ? value : "normal")}
        />
      </Field>
      <Field.Row>
        {field("storageBytes", props.t.storageLimit, GB, props.t.gb, props.t.storageLimitDescription)}
        {field("valuesPerMinute", props.t.valuesPerMinute, 1, undefined, props.t.valuesPerMinuteDescription)}
      </Field.Row>
      <Field.Row>
        {field("bytesPerMinute", props.t.bytesPerMinute, MIB, props.t.mib)}
        {field("queriesPerHour", props.t.queriesPerHour)}
      </Field.Row>
      <Field.Row>
        {field("maxSeries", props.t.maxSeries)}
        {field("maxEventKinds", props.t.maxEventKinds)}
        {field("maxStateKeys", props.t.maxStateKeys)}
      </Field.Row>
    </Band>
  );
}

/** Starting values for new bases and the instance's caps. */
function DefaultsDialog(props: {
  t: PulseAdminMessages;
  policy: PulsePolicy | null;
  signal: AbortSignal;
  close: (saved: PulsePolicy | null) => void;
}) {
  return (
    <Show when={props.policy} keyed>
      {(policy) => {
        const [profile, setProfile] = createSignal(policy.defaultProfile);
        const [limits, setLimits] = createSignal(policy.defaultLimits);
        const [maxBases, setMaxBases] = createSignal(String(policy.maxBases));
        const [maxRaw, setMaxRaw] = createSignal(String(policy.maxRawRetentionDays));
        const [busy, setBusy] = createSignal(false);
        const [error, setError] = createSignal("");
        const submit = async () => {
          if (busy()) return;
          setBusy(true);
          setError("");
          try {
            props.close(
              await adminClient.savePolicy(
                {
                  defaultProfile: profile(),
                  defaultLimits: limits(),
                  maxBases: Number(maxBases()) || policy.maxBases,
                  maxRawRetentionDays: Number(maxRaw()) || policy.maxRawRetentionDays,
                },
                props.signal,
              ),
            );
          } catch (cause) {
            if (!props.signal.aborted) setError(adminErrorText(props.t, codeOf(cause)));
          } finally {
            setBusy(false);
          }
        };
        return (
          <Dialog
            title={props.t.defaultsDialogTitle}
            open
            onOpenChange={(open) => {
              if (!open && !busy()) props.close(null);
            }}
            foot={
              <>
                <Button disabled={busy()} onClick={() => props.close(null)}>
                  {props.t.cancel}
                </Button>
                <Button variant="primary" busy={busy()} onClick={() => void submit()}>
                  {props.t.save}
                </Button>
              </>
            }
          >
            <Show when={error()}>
              {(message) => (
                <Notice tone="bad" icon="alert-circle">
                  {message()}
                </Notice>
              )}
            </Show>
            <Text>{props.t.defaultsDialogIntro}</Text>
            <Field.Row>
              <Field name="maxBases" label={props.t.maxBases} hint={props.t.maxBasesDescription} required>
                <Input type="number" min={1} max={100_000} value={maxBases()} disabled={busy()} onInput={setMaxBases} />
              </Field>
              <Field
                name="maxRaw"
                label={props.t.maxRawRetention}
                optional={props.t.days}
                hint={props.t.maxRawRetentionDescription}
                required
              >
                <Input type="number" min={1} max={3650} value={maxRaw()} disabled={busy()} onInput={setMaxRaw} />
              </Field>
            </Field.Row>
            <LimitsFields
              t={props.t}
              profile={profile()}
              setProfile={setProfile}
              limits={limits()}
              setLimit={(key, value) => setLimits({ ...limits(), [key]: value })}
              disabled={busy()}
            />
          </Dialog>
        );
      }}
    </Show>
  );
}

/** The limits of one base; also the place where its state deeds stand. */
function LimitsDialog(props: {
  t: PulseAdminMessages;
  row: AdminBaseRow | null;
  signal: AbortSignal;
  close: (saved: AdminBaseRow | null) => void;
  act: (row: AdminBaseRow, action: BaseAction) => void;
}) {
  const locale = useLocale();
  return (
    <Show when={props.row} keyed>
      {(row) => {
        const [profile, setProfile] = createSignal(row.store.profile);
        const [limits, setLimits] = createSignal(row.store.limits);
        const [busy, setBusy] = createSignal(false);
        const [error, setError] = createSignal("");
        const submit = async () => {
          if (busy()) return;
          setBusy(true);
          setError("");
          try {
            props.close(await adminClient.saveLimits(row.id, { profile: profile(), limits: limits() }, props.signal));
          } catch (cause) {
            if (!props.signal.aborted) setError(adminErrorText(props.t, codeOf(cause)));
          } finally {
            setBusy(false);
          }
        };
        const deed = (action: BaseAction) => () => {
          props.close(null);
          props.act(row, action);
        };
        return (
          <Dialog
            title={props.t.limitsTitle({ name: row.name })}
            open
            onOpenChange={(open) => {
              if (!open && !busy()) props.close(null);
            }}
            foot={
              <>
                <Button disabled={busy()} onClick={() => props.close(null)}>
                  {props.t.cancel}
                </Button>
                <Button variant="primary" busy={busy()} onClick={() => void submit()}>
                  {props.t.save}
                </Button>
              </>
            }
          >
            <Show when={row.store.state === "failed"}>
              <Notice
                tone="bad"
                icon="alert-circle"
                title={props.t.stateFailed}
                meta={row.store.errorCode ?? undefined}
                actions={[{ label: props.t.retry, icon: "refresh", onClick: deed("retry") }]}
              >
                {failedOperationText(props.t, row.store)}
              </Notice>
            </Show>
            <Show when={row.store.state === "active" && row.store.writeBlockReason}>
              <Notice
                tone="warn"
                icon="lock"
                title={props.t.stateWriteBlocked}
                actions={[
                  { label: props.t.recheck, icon: "refresh", onClick: deed("recheck") },
                  { label: props.t.recreate, icon: "database-off", onClick: deed("recreate") },
                ]}
              >
                {row.store.writeBlockReason === "database_missing" ? props.t.blockedMissing : props.t.blockedMismatch}
              </Notice>
            </Show>
            <Show when={error()}>
              {(message) => (
                <Notice tone="bad" icon="alert-circle">
                  {message()}
                </Notice>
              )}
            </Show>
            <Text>{props.t.limitsIntro}</Text>
            <Show when={row.store.usage}>
              {(usage) => (
                <Text type="meta" muted>
                  {`${props.t.usageNow({ used: bytes(usage().bytes, locale()) })} ${new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(usage().measuredAt))}`}
                </Text>
              )}
            </Show>
            <LimitsFields
              t={props.t}
              profile={profile()}
              setProfile={setProfile}
              limits={limits()}
              setLimit={(key, value) => setLimits({ ...limits(), [key]: value })}
              disabled={busy()}
            />
          </Dialog>
        );
      }}
    </Show>
  );
}

/** Databases in ClickHouse without a base: read by the browser after the page shows, so ClickHouse never delays it. */
function Orphans(props: { t: PulseAdminMessages; signal: AbortSignal }) {
  const toast = useToast();
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
      if (!props.signal.aborted) toast(adminErrorText(props.t, codeOf(cause)), { status: "bad" });
    }
  };
  const remove = async (database: string) => {
    const agreed = await Dialog.confirm({
      title: props.t.deleteOrphanTitle({ database }),
      description: props.t.deleteOrphanText,
      confirm: props.t.delete,
      cancel: props.t.cancel,
    });
    if (!agreed) return;
    setBusy(database);
    try {
      await adminClient.deleteOrphan(database, props.signal);
      const current = view();
      if (current.kind === "ready") setView({ ...current, items: current.items.filter((item) => item.database !== database) });
    } catch (cause) {
      if (!props.signal.aborted) toast(adminErrorText(props.t, codeOf(cause)), { status: "bad" });
    } finally {
      setBusy(null);
    }
  };
  onMount(() => void load());
  const ready = () => {
    const current = view();
    return current.kind === "ready" ? current : null;
  };
  return (
    <Section
      icon="unlink"
      title={props.t.orphansTitle}
      summary={props.t.orphansDescription}
      count={ready()?.items.length || undefined}
      more={ready()?.nextCursor !== null && ready() ? { label: props.t.loadMore, onClick: () => void more() } : undefined}
    >
      <Show when={view().kind !== "loading"} fallback={<Loading rows={2} />}>
        <Show when={ready()} fallback={<Failed text={props.t.orphansFailed} onRetry={() => void load()} />}>
          {(current) => (
            // A bounded scan may end before it found an orphan; "Show more" continues it.
            <Show
              when={current().items.length > 0 || current().nextCursor !== null}
              fallback={<Empty icon="circle-check" text={props.t.orphansNone} />}
            >
              <List label={props.t.orphansTitle}>
                <For each={current().items}>
                  {(item) => (
                    <Row
                      icon="database-off"
                      lines={[item.database]}
                      end={<Chip status="warn">{props.t.orphanBadge}</Chip>}
                      action={{
                        label: props.t.delete,
                        icon: "trash",
                        disabled: busy() !== null,
                        onClick: () => void remove(item.database),
                      }}
                    />
                  )}
                </For>
              </List>
            </Show>
          )}
        </Show>
      </Show>
    </Section>
  );
}

/** The bases of the instance: who may create them, their starting values, each base's limits and state. */
export default function BasesView(props: { label: string; initialPolicy: PulsePolicy | null; initialPage: AdminBasesPage | null }) {
  const locale = useLocale();
  const t = createMemo(() => pulseAdminMessages.resolve([locale()]).t);
  const toast = useToast();
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
  const [editingDefaults, setEditingDefaults] = createSignal(false);
  const [editing, setEditing] = createSignal<AdminBaseRow | null>(null);

  const apply = (page: AdminBasesPage, append: boolean) => {
    const known = new Set(append ? rows().map((row) => row.id) : []);
    setRows(append ? [...rows(), ...page.items.filter((row) => !known.has(row.id))] : page.items);
    setTotal(page.total);
    setNextOffset(page.nextOffset);
    setUsed(page.usedBytes);
    setDisk(page.disk);
  };
  const reload = async () => {
    setLoading(true);
    try {
      const [nextPolicy, page] = await Promise.all([
        adminClient.policy(controller.signal),
        adminClient.bases({ limit: PAGE_SIZE }, controller.signal),
      ]);
      setPolicy(nextPolicy);
      apply(page, false);
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
      apply(await adminClient.bases({ limit: PAGE_SIZE, offset }, controller.signal), true);
    } catch (cause) {
      if (!controller.signal.aborted) toast(adminErrorText(t(), codeOf(cause)), { status: "bad" });
    } finally {
      setLoadingMore(false);
    }
  };
  const replace = (next: AdminBaseRow) => setRows(rows().map((row) => (row.id === next.id ? next : row)));
  // A queued operation finishes or fails in the background: follow every running row to its end. A deleted base
  // keeps its row, marked deleted, until the next reload.
  const [deletedIds, setDeletedIds] = createSignal<ReadonlySet<string>>(new Set());
  const running = () => rows().filter((row) => !deletedIds().has(row.id) && storeBadge(t(), row.store)?.running);
  const followed = installPeriodicRefresh({
    active: () => running().length > 0 && rowBusy() === null,
    refresh: async () => {
      for (const row of running()) {
        const page = await adminClient.bases({ q: row.id, limit: 1 }, controller.signal);
        const next = page.items.find((item) => item.id === row.id);
        if (next) replace(next);
        else if (row.store.state === "deleting") setDeletedIds(new Set([...deletedIds(), row.id]));
      }
    },
  });
  const setCreation = async (value: BaseCreationPolicy) => {
    const current = policy();
    if (!current || value === current.baseCreation || policyBusy()) return;
    setPolicyBusy(true);
    // The choice shows at once; a refusal puts the saved value back.
    setPolicy({ ...current, baseCreation: value });
    try {
      setPolicy(await adminClient.savePolicy({ baseCreation: value }, controller.signal));
      toast(t().saved, { status: "ok" });
    } catch (cause) {
      if (controller.signal.aborted) return;
      setPolicy(current);
      toast(adminErrorText(t(), codeOf(cause)), { status: "bad" });
    } finally {
      setPolicyBusy(false);
    }
  };
  const act = async (row: AdminBaseRow, action: BaseAction) => {
    if (rowBusy()) return;
    if (action === "recreate") {
      const agreed = await Dialog.confirm({
        title: t().recreateConfirmTitle({ name: row.name }),
        description: t().recreateConfirmText,
        confirm: t().recreate,
        cancel: t().cancel,
      });
      if (!agreed) return;
    }
    setRowBusy(row.id);
    try {
      replace(await adminClient.baseAction(row.id, action, controller.signal));
      if (action === "retry") toast(t().retryStarted, { status: "ok" });
    } catch (cause) {
      if (!controller.signal.aborted) toast(adminErrorText(t(), codeOf(cause)), { status: "bad" });
    } finally {
      setRowBusy(null);
    }
  };
  const lead = () => {
    const free = disk();
    return free
      ? t().basesSubtitle({ count: total(), used: bytes(used(), locale()), free: bytes(free.freeBytes, locale()) })
      : t().basesSubtitleNoDisk({ count: total(), used: bytes(used(), locale()) });
  };
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
  const blocked = () => rows().filter((row) => row.store.state === "active" && row.store.writeBlockReason);
  const badge = (row: AdminBaseRow) => {
    const stale = followed.failed() && running().some((item) => item.id === row.id);
    if (deletedIds().has(row.id)) return { label: t().stateDeleted };
    if (stale) return { status: "warn" as const, label: t().stateStale };
    return storeBadge(t(), row.store);
  };
  const stateCell = (row: AdminBaseRow) => {
    const value = badge(row);
    if (!value) return row.rollupLag ? <Chip status="warn">{t().rollupLag}</Chip> : <Chip status="ok">{t().stateActive}</Chip>;
    return "status" in value && value.status ? <Chip status={value.status}>{value.label}</Chip> : <Chip>{value.label}</Chip>;
  };
  const admins = (row: AdminBaseRow) =>
    `${row.admins.length ? row.admins.join(", ") : t().noAdmins}${row.adminCount > row.admins.length ? ` ${t().adminsMore({ count: row.adminCount - row.admins.length })}` : ""}`;

  return (
    <Pane
      label={props.label}
      scrollKey="pulse-admin-bases"
      status={
        <StatusRow
          lead={loadFailed() ? t().basesTitle : lead()}
          loading={loading()}
          facts={running().length > 0 && followed.failed() ? [{ value: t().stateStale, after: t().staleHelp }] : []}
        />
      }
    >
      <Show
        when={!loadFailed() && policy()}
        fallback={<Failed text={`${t().basesLoadFailed} ${t().basesLoadFailedDescription}`} onRetry={() => void reload()} />}
      >
        <Band>
          <Text>{t().basesIntro}</Text>
          <Field name="creation" label={t().creationTitle} hint={t().creationDescription}>
            <Select
              options={[
                { value: "everyone", label: t().creationEveryone },
                { value: "people", label: t().creationPeople },
                { value: "admins", label: t().creationAdmins },
              ]}
              value={policy()?.baseCreation ?? "everyone"}
              onChange={(value) => void setCreation(value === "people" || value === "admins" ? value : "everyone")}
            />
          </Field>
        </Band>
        <Section
          icon="adjustments"
          title={t().defaultsTitle}
          summary={t().defaultsDescription}
          actions={[{ label: t().editDefaults, icon: "pencil", onClick: () => setEditingDefaults(true) }]}
        >
          <Facts items={[{ label: t().defaultsTitle, value: defaultsSummary() }]} />
        </Section>
        <Show when={blocked().length > 0}>
          <Section icon="lock" title={t().blockedTitle({ count: blocked().length })} summary={t().blockedHelp}>
            <List label={t().stateWriteBlocked}>
              <For each={blocked()}>
                {(row) => (
                  <Row
                    icon="lock"
                    lines={[row.name, row.store.writeBlockReason === "database_missing" ? t().blockedMissing : t().blockedMismatch]}
                    action={{ label: t().recheck, icon: "refresh", disabled: rowBusy() !== null, onClick: () => void act(row, "recheck") }}
                    end={
                      <Menu
                        label={`${t().recreate}: ${row.name}`}
                        items={[
                          {
                            label: t().recreate,
                            icon: "database-off",
                            danger: true,
                            disabled: rowBusy() !== null,
                            onClick: () => void act(row, "recreate"),
                          },
                        ]}
                      />
                    }
                  />
                )}
              </For>
            </List>
          </Section>
        </Show>
        {/* k2b-ui gap: v2 Table does not virtualize yet (lane MW); the list loads 50 bases a page. */}
        <Table
          label={t().basesTitle}
          rows={rows()}
          rowKey={(row) => row.id}
          open={(row) => ({ onOpen: () => row.store.state !== "deleting" && !deletedIds().has(row.id) && setEditing(row) })}
          empty={{ icon: "database", text: t().basesEmpty }}
          phone={(row) => ({
            lines: [
              row.name,
              `${profileLabel(t(), row.store.profile)} · ${row.store.usage ? bytes(row.store.usage.bytes, locale()) : t().notMeasured}`,
            ],
            marks: stateCell(row),
          })}
          columns={[
            { title: t().colBase, width: { min: 180, default: 240 }, cell: (row) => ({ lines: [row.name, admins(row)] }) },
            { title: t().colState, width: { min: 150, default: 170 }, cell: stateCell },
            { title: t().colProfile, width: { min: 90, default: 100 }, drop: true, cell: (row) => profileLabel(t(), row.store.profile) },
            {
              title: t().colStorage,
              align: "end",
              width: { min: 140, default: 160 },
              cell: (row) =>
                row.store.usage
                  ? t().storageOf({ used: bytes(row.store.usage.bytes, locale()), limit: bytes(row.store.limits.storageBytes, locale()) })
                  : t().notMeasured,
            },
            {
              title: t().colValues,
              align: "end",
              width: { min: 100, default: 120 },
              drop: true,
              cell: (row) => number(row.store.limits.valuesPerMinute, locale()),
            },
            {
              title: t().colRetention,
              align: "end",
              drop: true,
              cell: (row) => t().retentionOf({ days: row.rawRetentionDays, max: policy()?.maxRawRetentionDays ?? row.rawRetentionDays }),
            },
          ]}
        />
        <Show when={nextOffset() !== null}>
          <Bar
            end={
              <Button icon="chevrons-down" busy={loadingMore()} onClick={() => void more()}>
                {t().loadMore}
              </Button>
            }
          />
        </Show>
        <Text type="meta" muted>
          {t().amountsOnly}
        </Text>
      </Show>
      <Orphans t={t()} signal={controller.signal} />
      <Show when={editingDefaults()}>
        <DefaultsDialog
          t={t()}
          policy={policy()}
          signal={controller.signal}
          close={(saved) => {
            setEditingDefaults(false);
            if (saved) {
              setPolicy(saved);
              toast(t().saved, { status: "ok" });
            }
          }}
        />
      </Show>
      <LimitsDialog
        t={t()}
        row={editing()}
        signal={controller.signal}
        act={(row, action) => void act(row, action)}
        close={(saved) => {
          setEditing(null);
          if (saved) {
            replace(saved);
            toast(t().saved, { status: "ok" });
          }
        }}
      />
    </Pane>
  );
}
