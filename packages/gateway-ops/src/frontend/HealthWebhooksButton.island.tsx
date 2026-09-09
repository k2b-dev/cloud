import { mutation } from "@k2b/stdlib/solid";
import {
  Button,
  CheckboxCard,
  DataTable,
  type DataTableColumn,
  dialogCore,
  NoticeCard,
  NumberInput,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  prompts,ScrollArea,
  Select,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { formatDateTime as fmtDateTime } from "@k2b/cloud/shared";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { type GatewayOpsMessages, gatewayOpsMessages } from "../messages";
import {
  createHealthWebhookQueries,
  type HealthApp,
  type HealthWebhook,
  type HealthWebhookInput,
  readHealthWebhookResponse,
  responseErrorMessage,
  type SettingEntry,
} from "./health-webhook-queries";

const defaultWebhook = (): HealthWebhookInput => ({
  name: "",
  url: "",
  method: "GET",
  enabled: true,
  scopeKind: "all",
  scopeAppIds: [],
  sendOn: ["error", "recovery"],
  minStatus: "error",
  repeatIntervalMs: 1_800_000,
  timeoutMs: 5000,
});

const toInput = (webhook?: HealthWebhook): HealthWebhookInput => ({
  ...(webhook ?? defaultWebhook()),
  name: webhook?.name ?? "",
  url: webhook?.url ?? "",
});

const toggle = <T extends string>(items: T[], item: T, checked: boolean) =>
  checked ? Array.from(new Set([...items, item])) : items.filter((value) => value !== item);

const appStatusDescription = (app: HealthApp, t: GatewayOpsMessages) => {
  if (!app.online) return t.appOfflineDescription({ id: app.id });
  if (app.signals.length > 0) return `${app.signals.join(" · ")} · ${app.id}`;
  if (app.status === "warn") return t.appStaleDescription({ id: app.id });
  return t.appLiveDescription({ id: app.id });
};

const fmtMinutes = (value: number) => `${Math.round(value / 60_000)} min`;

const statusClasses: Record<NonNullable<HealthWebhook["lastStatus"]> | "new", string> = {
  ok: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warn: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  error: "bg-red-500/10 text-red-500",
  new: "bg-zinc-500/10 text-dimmed",
};

const methodOptions = (t: GatewayOpsMessages) => [
  {
    id: "GET",
    label: "GET ping",
    description: t.getPingDescription,
    icon: "ti ti-arrow-up-right",
  },
  {
    id: "POST",
    label: "POST JSON",
    description: t.postJsonDescription,
    icon: "ti ti-json",
  },
];

const statusOptions = (t: GatewayOpsMessages) => [
  { id: "ok", label: t.ok, description: t.statusOkDescription, icon: "ti ti-check" },
  { id: "warn", label: t.warning, description: t.statusWarningDescription, icon: "ti ti-alert-triangle" },
  { id: "error", label: t.error, description: t.statusErrorDescription, icon: "ti ti-alert-circle" },
];

const scopeOptions = (t: GatewayOpsMessages) => [
  { id: "all", label: t.allApps, description: t.allAppsDescription, icon: "ti ti-apps" },
  { id: "include", label: t.selectedOnly, description: t.selectedOnlyDescription, icon: "ti ti-filter-check" },
  { id: "exclude", label: t.excludeSelected, description: t.excludeSelectedDescription, icon: "ti ti-filter-x" },
];

const sendOptions = (t: GatewayOpsMessages) => [
  { id: "ok", label: t.ok, description: t.triggerOkDescription, icon: "ti ti-check" },
  { id: "warn", label: t.warning, description: t.triggerWarningDescription, icon: "ti ti-alert-triangle" },
  { id: "error", label: t.error, description: t.triggerErrorDescription, icon: "ti ti-alert-circle" },
  { id: "recovery", label: t.recovery, description: t.recoveryDescription, icon: "ti ti-heartbeat" },
  { id: "every_check", label: t.everyCheck, description: t.everyCheckDescription, icon: "ti ti-clock" },
] as const;

export const WebhookEditor = (props: { webhook?: HealthWebhook; apps: HealthApp[]; close: () => void; onSaved: () => Promise<void> }) => {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  const webhook = props.webhook;
  const initial = toInput(webhook);
  const [data, setData] = createSignal<HealthWebhookInput>(initial);
  const [persisted, setPersisted] = createSignal(false);
  const [reconciling, setReconciling] = createSignal(false);
  const [reconcileError, setReconcileError] = createSignal<Error | null>(null);
  let disposed = false;

  const save = mutation.create<HealthWebhook, HealthWebhookInput>({
    mutation: async (input, { abortSignal }) => {
      const response = webhook
        ? await apiClient.health.webhooks[":id"].$put({ param: { id: webhook.id }, json: input }, { init: { signal: abortSignal } })
        : await apiClient.health.webhooks.$post({ json: input }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await responseErrorMessage(response, t.saveWebhookFailed));
      return readHealthWebhookResponse(response, t.unexpectedWebhookResponse);
    },
  });
  const busy = () => save.loading() || reconciling();
  const requestClose = () => {
    if (!busy()) props.close();
  };
  const reconcile = async () => {
    if (reconciling()) return;
    setReconciling(true);
    setReconcileError(null);
    try {
      await props.onSaved();
    } catch (error) {
      if (!disposed) setReconcileError(error instanceof Error ? error : new Error(String(error)));
      if (!disposed) setReconciling(false);
      return;
    }
    if (disposed) return;
    setReconciling(false);
    props.close();
    toast.success(t.webhookSaved);
  };
  const submit = async () => {
    if (busy() || persisted()) return;
    const current = data();
    const input: HealthWebhookInput = {
      ...current,
      scopeAppIds: [...current.scopeAppIds],
      sendOn: [...current.sendOn],
    };
    await save.mutate(input);
    if (disposed) return;
    if (save.error()) {
      void prompts.error(save.error()!.message);
      return;
    }
    setPersisted(true);
    await reconcile();
  };
  onCleanup(() => {
    disposed = true;
    save.abort();
  });

  return (
    <form
      class="contents"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <PanelDialog>
        <PanelDialog.Header
          title={webhook ? t.editWebhook : t.addWebhook}
          subtitle={t.webhookEditorDescription}
          icon="ti ti-heartbeat"
          close={requestClose}
        />
        <PanelDialog.Body>
          <CheckboxCard
            label={t.enabled}
            description={t.enabledDescription}
            icon="ti ti-power"
            value={() => data().enabled}
            onValueChange={(enabled) => setData({ ...data(), enabled })}
          />
          <TextInput
            label={t.name}
            description={t.webhookNameDescription}
            icon="ti ti-tag"
            value={() => data().name}
            onValueChange={(name) => setData({ ...data(), name })}
            required
          />

          <PanelDialog.Section title={t.delivery} subtitle={t.deliveryDescription} icon="ti ti-send">
            <div class="grid gap-3 md:grid-cols-2">
              <Select
                label={t.method}
                description={t.methodDescription}
                icon="ti ti-send"
                value={() => data().method}
                onValueChange={(method) => setData({ ...data(), method: method as "GET" | "POST" })}
                options={methodOptions(t)}
              />
              <TextInput
                label="URL"
                description={t.urlDescription}
                type="url"
                icon="ti ti-link"
                value={() => data().url}
                onValueChange={(url) => setData({ ...data(), url })}
                required
              />
            </div>
            <div class="grid gap-3 md:grid-cols-2">
              <Select
                label={t.minimumStatus}
                description={t.minimumStatusDescription}
                icon="ti ti-activity"
                value={() => data().minStatus}
                onValueChange={(minStatus) => setData({ ...data(), minStatus: minStatus as "ok" | "warn" | "error" })}
                options={statusOptions(t)}
              />
              <NumberInput
                label={t.repeatInterval}
                description={t.repeatIntervalDescription}
                icon="ti ti-repeat"
                min={1}
                suffix="min"
                value={() => Math.round(data().repeatIntervalMs / 60_000)}
                onValueChange={(minutes) => setData({ ...data(), repeatIntervalMs: Math.max(1, minutes ?? 1) * 60_000 })}
              />
            </div>
          </PanelDialog.Section>

          <PanelDialog.Section title={t.sendWhen} subtitle={t.sendWhenDescription} icon="ti ti-bell-ringing">
            <div class="grid gap-2 md:grid-cols-2">
              <For each={sendOptions(t)}>
                {(item) => (
                  <CheckboxCard
                    label={item.label}
                    description={item.description}
                    icon={item.icon}
                    value={() => data().sendOn.includes(item.id)}
                    onValueChange={(checked) => setData({ ...data(), sendOn: toggle(data().sendOn, item.id, checked) })}
                  />
                )}
              </For>
            </div>
            <Select
              label={t.scope}
              description={t.scopeDescription}
              icon="ti ti-filter"
              value={() => data().scopeKind}
              onValueChange={(scopeKind) => setData({ ...data(), scopeKind: scopeKind as "all" | "include" | "exclude" })}
              options={scopeOptions(t)}
            />
            <Show when={data().scopeKind !== "all"}>
              <ScrollArea class="grid max-h-48 gap-2 md:grid-cols-2">
                <For each={props.apps}>
                  {(app) => (
                    <CheckboxCard
                      label={app.name}
                      description={appStatusDescription(app, t)}
                      icon={app.icon}
                      value={() => data().scopeAppIds.includes(app.id)}
                      onValueChange={(checked) => setData({ ...data(), scopeAppIds: toggle(data().scopeAppIds, app.id, checked) })}
                    />
                  )}
                </For>
              </ScrollArea>
            </Show>
          </PanelDialog.Section>
          <Show when={reconcileError()}>
            {(error) => (
              <NoticeCard tone="danger" title={t.webhookSavedRefreshFailed} detail={error().message}>
                <Button type="button" size="sm" onClick={() => void reconcile()} disabled={reconciling()}>
                  {t.retryRefresh}
                </Button>
              </NoticeCard>
            )}
          </Show>
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <Button type="button" variant="secondary" size="sm" onClick={requestClose} disabled={busy()}>
            {t.cancel}
          </Button>
          <Button type="submit" size="sm" disabled={busy() || persisted()}>
            <i class={`ti ${busy() ? "ti-loader-2 animate-spin" : "ti-check"} text-sm`} />
            {t.save}
          </Button>
        </PanelDialog.Footer>
      </PanelDialog>
    </form>
  );
};

const openWebhookEditor = (webhook: HealthWebhook | undefined, apps: HealthApp[], onSaved: () => Promise<void>) =>
  dialogCore.open<void>((close) => <WebhookEditor webhook={webhook} apps={apps} close={() => close()} onSaved={onSaved} />, {
    ...panelDialogOptions,
    cancelBehavior: "ignore",
  });

const ScheduleEditor = (props: { schedule: SettingEntry | undefined; close: () => void; onSaved: () => Promise<void> }) => {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  const initial = String(props.schedule?.value ?? props.schedule?.default ?? "*/5 * * * *");
  const [scheduleValue, setScheduleValue] = createSignal(initial);
  const [persisted, setPersisted] = createSignal(false);
  const [reconciling, setReconciling] = createSignal(false);
  const [reconcileError, setReconcileError] = createSignal<Error | null>(null);
  let disposed = false;

  const save = mutation.create<void, string>({
    mutation: async (value, { abortSignal }) => {
      const response = await apiClient.settings[":key{.+}"].$put(
        {
          param: { key: "gateway.health_check_schedule" },
          json: { value },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await responseErrorMessage(response, t.saveScheduleFailed));
    },
  });
  const busy = () => save.loading() || reconciling();
  const requestClose = () => {
    if (!busy()) props.close();
  };
  const reconcile = async () => {
    if (reconciling()) return;
    setReconciling(true);
    setReconcileError(null);
    try {
      await props.onSaved();
    } catch (error) {
      if (!disposed) setReconcileError(error instanceof Error ? error : new Error(String(error)));
      if (!disposed) setReconciling(false);
      return;
    }
    if (disposed) return;
    setReconciling(false);
    props.close();
    toast.success(t.scheduleSaved);
  };
  const submit = async () => {
    if (busy() || persisted()) return;
    const value = scheduleValue().trim() || initial;
    await save.mutate(value);
    if (disposed) return;
    if (save.error()) {
      void prompts.error(save.error()!.message);
      return;
    }
    setPersisted(true);
    await reconcile();
  };
  onCleanup(() => {
    disposed = true;
    save.abort();
  });

  return (
    <form
      class="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <TextInput
        label={t.schedule}
        description={t.cronDescription}
        icon="ti ti-calendar-time"
        value={scheduleValue}
        onValueChange={setScheduleValue}
        required
      />
      <Show when={reconcileError()}>
        {(error) => (
          <NoticeCard tone="danger" title={t.scheduleSavedRefreshFailed} detail={error().message}>
            <Button type="button" size="sm" onClick={() => void reconcile()} disabled={reconciling()}>
              {t.retryRefresh}
            </Button>
          </NoticeCard>
        )}
      </Show>
      <div class="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={requestClose} disabled={busy()}>
          {t.cancel}
        </Button>
        <Button type="submit" size="sm" disabled={busy() || persisted()}>
          <i class={`ti ${busy() ? "ti-loader-2 animate-spin" : "ti-check"} text-sm`} />
          {t.save}
        </Button>
      </div>
    </form>
  );
};

const openScheduleEditor = (schedule: SettingEntry | undefined, onSaved: () => Promise<void>) =>
  prompts.dialog<void>((close) => <ScheduleEditor schedule={schedule} close={() => close()} onSaved={onSaved} />, {
    title: gatewayOpsMessages.resolve([document.documentElement.lang]).t.checkSchedule,
    icon: "ti ti-calendar-time",
    size: "small",
    cancelBehavior: "ignore",
  });

export default function HealthWebhooksPanel() {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  const { health, settings, webhooks } = createHealthWebhookQueries({
    loadWebhooks: t.loadWebhooksFailed,
    loadSettings: t.loadScheduleFailed,
    loadHealth: t.loadAppHealthFailed,
  });
  const [confirming, setConfirming] = createSignal(false);
  let disposed = false;
  const schedule = () => settings.data()?.find((entry) => entry.key === "gateway.health_check_schedule");
  const queryBlocksWrite = (owner: {
    error: () => Error | null;
    loading: () => boolean;
    refreshing: () => boolean;
    stale: () => boolean;
  }) => owner.loading() || owner.refreshing() || owner.stale() || owner.error() !== null;
  const webhooksBlocked = () => queryBlocksWrite(webhooks);
  const scheduleBlocked = () => queryBlocksWrite(settings);
  const editorBlocked = () => webhooksBlocked() || queryBlocksWrite(health);

  const remove = mutation.create<void, { id: string; name: string }>({
    mutation: async (target, { abortSignal }) => {
      const response = await apiClient.health.webhooks[":id"].$delete({ param: { id: target.id } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await responseErrorMessage(response, t.deleteWebhookFailed));
    },
  });

  const test = mutation.create<void, { id: string }>({
    mutation: async (target, { abortSignal }) => {
      const response = await apiClient.health.webhooks[":id"].test.$post({ param: { id: target.id } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await responseErrorMessage(response, t.testWebhookFailed));
    },
  });

  const removeWebhook = async (webhook: HealthWebhook) => {
    if (confirming() || remove.loading() || webhooksBlocked()) return;
    const target = { id: webhook.id, name: webhook.name };
    setConfirming(true);
    let confirmed = false;
    try {
      confirmed = (await prompts.confirm(t.deleteWebhookConfirm({ name: target.name }), { title: t.deleteWebhookTitle, variant: "danger" })) === true;
    } finally {
      if (!disposed) setConfirming(false);
    }
    if (!confirmed || disposed || webhooksBlocked()) return;
    await remove.mutate(target);
    if (disposed) return;
    if (remove.error()) {
      void prompts.error(remove.error()!.message);
      return;
    }
    try {
      await webhooks.invalidate();
      if (!disposed) toast.success(t.webhookDeleted);
    } catch {
      if (!disposed) toast.error(t.webhookDeletedRefreshFailed);
    }
  };
  const testWebhook = async (webhook: HealthWebhook) => {
    if (test.loading() || webhooksBlocked()) return;
    await test.mutate({ id: webhook.id });
    if (disposed) return;
    if (test.error()) void prompts.error(test.error()!.message);
    else toast.success(t.webhookTestSubmitted);
  };
  const openEditor = (webhook?: HealthWebhook) => {
    if (editorBlocked()) return;
    void openWebhookEditor(webhook, health.data()?.apps ?? [], () => webhooks.invalidate());
  };
  onCleanup(() => {
    disposed = true;
    remove.abort();
    test.abort();
  });

  const columns: DataTableColumn<HealthWebhook>[] = [
    { id: "name", header: t.webhook, value: (webhook) => webhook.name },
    { id: "status", header: t.status, value: (webhook) => webhook.lastStatus, headerClass: "text-center", cellClass: "text-center" },
    { id: "method", header: t.method, value: (webhook) => webhook.method },
    { id: "minimum", header: t.minimum, value: (webhook) => webhook.minStatus },
    { id: "repeat", header: t.repeat, value: (webhook) => webhook.repeatIntervalMs, headerClass: "text-right", cellClass: "text-right" },
    { id: "lastSent", header: t.lastSent, value: (webhook) => webhook.lastSentAt, headerClass: "text-right", cellClass: "text-right" },
    {
      id: "actions",
      header: <span class="sr-only">{t.actions}</span>,
      headerClass: "text-right",
      cellClass: "text-right whitespace-nowrap max-w-none",
    },
  ];

  return (
    <section class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0" style="view-transition-name: admin-webhooks-title">
          <h1 class="text-base font-semibold text-primary">{t.healthWebhooks}</h1>
          <p class="mt-1 text-xs text-dimmed">
            {t.healthWebhooksDescription({ schedule: String(schedule()?.value ?? schedule()?.default ?? "*/5 * * * *") })}
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void openScheduleEditor(schedule(), () => settings.invalidate())}
            disabled={scheduleBlocked()}
          >
            <i class="ti ti-calendar-time" aria-hidden="true" />
            {t.schedule}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => void openEditor()} disabled={editorBlocked()}>
            <i class="ti ti-plus" aria-hidden="true" />
            {t.add}
          </Button>
        </div>
      </div>

      <Show when={settings.error()}>
        {(error) => (
          <NoticeCard tone="danger" title={t.loadScheduleFailed} detail={error().message}>
            <Button type="button" size="sm" onClick={() => void settings.refresh()} disabled={settings.refreshing()}>
              {t.retry}
            </Button>
          </NoticeCard>
        )}
      </Show>
      <Show when={health.error()}>
        {(error) => (
          <NoticeCard tone="danger" title={t.loadAppHealthFailed} detail={error().message}>
            <Button type="button" size="sm" onClick={() => void health.refresh()} disabled={health.refreshing()}>
              {t.retry}
            </Button>
          </NoticeCard>
        )}
      </Show>
      <Show when={webhooks.error()}>
        {(error) => (
          <NoticeCard tone="danger" title={t.loadWebhooksFailed} detail={error().message}>
            <Button type="button" size="sm" onClick={() => void webhooks.refresh()} disabled={webhooks.refreshing()}>
              {t.retry}
            </Button>
          </NoticeCard>
        )}
      </Show>

      <Show
        when={webhooks.data()}
        fallback={webhooks.error() ? null : <Placeholder state="loading" surface="paper" title={t.loadingWebhooks} />}
      >
        {(rows) => (
          <DataTable
            rows={rows()}
            columns={columns}
            getRowId={(webhook) => webhook.id}
            hoverRows
            highlightColumns={false}
            class="paper overflow-x-auto"
            tableClass="w-full text-sm"
            empty={t.noWebhooks}
            renderCell={({ row: webhook, col }) => {
              if (col.id === "name") {
                return (
                  <div class="min-w-0">
                    <div class="flex items-center gap-2">
                      <span class={`status-dot ${webhook.enabled ? "bg-emerald-500" : "bg-zinc-400"}`} />
                      <span class="truncate text-xs font-medium text-primary">{webhook.name || t.untitledWebhook}</span>
                      <span class="rounded bg-zinc-100 px-1.5 py-0.5 text-[9px] text-dimmed dark:bg-zinc-800">
                        {webhook.enabled ? t.enabled : t.disabled}
                      </span>
                    </div>
                    <p class="mt-0.5 truncate text-[10px] text-dimmed">{webhook.url}</p>
                    <Show when={webhook.lastError}>
                      {(lastError) => <p class="mt-0.5 truncate text-[10px] text-red-500">{lastError()}</p>}
                    </Show>
                  </div>
                );
              }
              if (col.id === "status") {
                const status = webhook.lastStatus ?? "new";
                const label = status === "ok" ? t.ok : status === "warn" ? t.warning : status === "error" ? t.error : t.newStatus;
                return <span class={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${statusClasses[status]}`}>{label}</span>;
              }
              if (col.id === "method") return <span class="text-xs font-medium text-secondary">{webhook.method}</span>;
              if (col.id === "minimum") return <span class="text-xs capitalize text-dimmed">{webhook.minStatus}</span>;
              if (col.id === "repeat") return <span class="text-xs tabular-nums text-dimmed">{fmtMinutes(webhook.repeatIntervalMs)}</span>;
              if (col.id === "lastSent") return <span class="text-xs tabular-nums text-dimmed">{fmtDateTime(webhook.lastSentAt, { locale: locale() })}</span>;
              if (col.id === "actions") {
                return (
                  <div class="flex justify-end gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void testWebhook(webhook)}
                      disabled={test.loading() || webhooksBlocked()}
                    >
                      {t.test}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => void openEditor(webhook)} disabled={editorBlocked()}>
                      {t.edit}
                    </Button>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      onClick={() => void removeWebhook(webhook)}
                      disabled={remove.loading() || confirming() || webhooksBlocked()}
                    >
                      {t.delete}
                    </Button>
                  </div>
                );
              }
              return "";
            }}
          />
        )}
      </Show>
    </section>
  );
}
