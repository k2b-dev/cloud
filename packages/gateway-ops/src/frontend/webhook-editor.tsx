import { mutation } from "@k2b/stdlib/solid";
import {
  Button,
  CheckboxCard,
  dialogCore,
  NoticeCard,
  NumberInput,
  PanelDialog,
  panelDialogOptions,
  prompts,
  ScrollArea,
  Select,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { type GatewayOpsMessages, gatewayOpsMessages } from "../messages";
import {
  type HealthApp,
  type HealthWebhook,
  type HealthWebhookInput,
  readHealthWebhookResponse,
  responseErrorMessage,
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

export const toInput = (webhook?: HealthWebhook): HealthWebhookInput => ({
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

const _fmtMinutes = (value: number) => `${Math.round(value / 60_000)} min`;

const _statusClasses: Record<NonNullable<HealthWebhook["lastStatus"]> | "new", string> = {
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

const sendOptions = (t: GatewayOpsMessages) =>
  [
    { id: "ok", label: t.ok, description: t.triggerOkDescription, icon: "ti ti-check" },
    { id: "warn", label: t.warning, description: t.triggerWarningDescription, icon: "ti ti-alert-triangle" },
    { id: "error", label: t.error, description: t.triggerErrorDescription, icon: "ti ti-alert-circle" },
    { id: "recovery", label: t.recovery, description: t.recoveryDescription, icon: "ti ti-heartbeat" },
    { id: "every_check", label: t.everyCheck, description: t.everyCheckDescription, icon: "ti ti-clock" },
  ] as const;

const FieldSection = (props: { title: string; subtitle: string; children: JSX.Element }) => (
  <section class="flex flex-col gap-3">
    <div>
      <h3 class="text-sm font-semibold text-primary">{props.title}</h3>
      <p class="text-xs text-dimmed">{props.subtitle}</p>
    </div>
    {props.children}
  </section>
);

/** The fields of one health webhook: in the dialog that adds one and in the detail column that edits one. */
export const WebhookFields = (props: {
  data: () => HealthWebhookInput;
  update: (change: Partial<HealthWebhookInput>) => void;
  apps: HealthApp[];
  /** Field errors by name: `name`, `url`. */
  errors?: () => Record<string, string>;
  disabled?: boolean;
}) => {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  return (
    <>
      <CheckboxCard
        label={t.enabled}
        description={t.enabledDescription}
        icon="ti ti-power"
        value={() => props.data().enabled}
        onValueChange={(enabled) => props.update({ enabled })}
        disabled={props.disabled}
      />
      <TextInput
        label={t.name}
        description={t.webhookNameDescription}
        icon="ti ti-tag"
        value={() => props.data().name}
        onValueChange={(name) => props.update({ name })}
        error={() => props.errors?.().name}
        disabled={props.disabled}
        required
      />

      <FieldSection title={t.delivery} subtitle={t.deliveryDescription}>
        <div class="grid gap-3 md:grid-cols-2">
          <Select
            label={t.method}
            description={t.methodDescription}
            icon="ti ti-send"
            value={() => props.data().method}
            onValueChange={(method) => props.update({ method: method as "GET" | "POST" })}
            disabled={props.disabled}
            options={methodOptions(t)}
          />
          <TextInput
            label="URL"
            description={t.urlDescription}
            type="url"
            icon="ti ti-link"
            value={() => props.data().url}
            onValueChange={(url) => props.update({ url })}
            error={() => props.errors?.().url}
            disabled={props.disabled}
            required
          />
        </div>
        <div class="grid gap-3 md:grid-cols-2">
          <Select
            label={t.minimumStatus}
            description={t.minimumStatusDescription}
            icon="ti ti-activity"
            value={() => props.data().minStatus}
            onValueChange={(minStatus) => props.update({ minStatus: minStatus as "ok" | "warn" | "error" })}
            disabled={props.disabled}
            options={statusOptions(t)}
          />
          <NumberInput
            label={t.repeatInterval}
            description={t.repeatIntervalDescription}
            icon="ti ti-repeat"
            min={1}
            suffix="min"
            value={() => Math.round(props.data().repeatIntervalMs / 60_000)}
            onValueChange={(minutes) => props.update({ repeatIntervalMs: Math.max(1, minutes ?? 1) * 60_000 })}
            disabled={props.disabled}
          />
        </div>
      </FieldSection>

      <FieldSection title={t.sendWhen} subtitle={t.sendWhenDescription}>
        <div class="grid gap-2 md:grid-cols-2">
          <For each={sendOptions(t)}>
            {(item) => (
              <CheckboxCard
                label={item.label}
                description={item.description}
                icon={item.icon}
                value={() => props.data().sendOn.includes(item.id)}
                onValueChange={(checked) => props.update({ sendOn: toggle(props.data().sendOn, item.id, checked) })}
                disabled={props.disabled}
              />
            )}
          </For>
        </div>
        <Select
          label={t.scope}
          description={t.scopeDescription}
          icon="ti ti-filter"
          value={() => props.data().scopeKind}
          onValueChange={(scopeKind) => props.update({ scopeKind: scopeKind as "all" | "include" | "exclude" })}
          disabled={props.disabled}
          options={scopeOptions(t)}
        />
        <Show when={props.data().scopeKind !== "all"}>
          <ScrollArea class="grid max-h-48 gap-2 md:grid-cols-2">
            <For each={props.apps}>
              {(app) => (
                <CheckboxCard
                  label={app.name}
                  description={appStatusDescription(app, t)}
                  icon={app.icon}
                  value={() => props.data().scopeAppIds.includes(app.id)}
                  onValueChange={(checked) => props.update({ scopeAppIds: toggle(props.data().scopeAppIds, app.id, checked) })}
                  disabled={props.disabled}
                />
              )}
            </For>
          </ScrollArea>
        </Show>
      </FieldSection>
    </>
  );
};

export const WebhookEditor = (props: {
  webhook?: HealthWebhook;
  apps: HealthApp[];
  close: () => void;
  onSaved: (saved: HealthWebhook | undefined) => Promise<void>;
}) => {
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
      await props.onSaved(save.data() ?? undefined);
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
          <WebhookFields data={data} update={(change) => setData({ ...data(), ...change })} apps={props.apps} />
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

export const openWebhookEditor = (
  webhook: HealthWebhook | undefined,
  apps: HealthApp[],
  onSaved: (saved: HealthWebhook | undefined) => Promise<void>,
) =>
  dialogCore.open<void>((close) => <WebhookEditor webhook={webhook} apps={apps} close={() => close()} onSaved={onSaved} />, {
    ...panelDialogOptions,
    cancelBehavior: "ignore",
  });
