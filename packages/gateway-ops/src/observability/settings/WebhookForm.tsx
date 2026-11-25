import { formatDateTime } from "@k2b/cloud/shared";
import { createSettingsDraft, oneStepFailure } from "@k2b/cloud/ssr/settings-draft";
import { useLocale } from "@k2b/ui";
import { Band, Bar, Button, Check, Choice, Field, Input, Notice, Text, useToast } from "@k2b/ui/v2";
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "../../api/client";
import {
  type HealthApp,
  type HealthWebhook,
  type HealthWebhookInput,
  readHealthWebhookResponse,
  responseErrorMessage,
} from "../../frontend/health-webhook-queries";
import { gatewayOpsMessages } from "../../messages";
import { areaMessages } from "../_components/area-messages";
import { SettingsOutcome } from "../_components/SettingsOutcome";

export const ALERTS_PATH = "/admin/observability/settings";
export const webhookHref = (id: string) => `${ALERTS_PATH}?webhook=${encodeURIComponent(id)}`;

const SEND_ON = ["ok", "warn", "error", "recovery", "every_check"] as const;

export const newWebhook = (): HealthWebhookInput => ({
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

const toInput = (webhook: HealthWebhook): HealthWebhookInput => ({
  name: webhook.name,
  url: webhook.url,
  method: webhook.method,
  enabled: webhook.enabled,
  scopeKind: webhook.scopeKind,
  scopeAppIds: [...webhook.scopeAppIds],
  sendOn: [...webhook.sendOn],
  minStatus: webhook.minStatus,
  repeatIntervalMs: webhook.repeatIntervalMs,
  timeoutMs: webhook.timeoutMs,
});

const toggle = <T extends string>(items: T[], item: T, checked: boolean) =>
  checked ? [...new Set([...items, item])] : items.filter((value) => value !== item);

/**
 * One alert's fields in the detail column. An existing alert saves with the button in the column's head; a new one
 * is created there and then opens as itself. The draft registers with `settingsSaveControls`.
 */
export default function WebhookForm(props: { webhook: HealthWebhook | null; apps: HealthApp[]; timeZone: string }) {
  const locale = useLocale();
  const t = () => areaMessages.resolve([locale()]).t;
  const g = () => gatewayOpsMessages.resolve([locale()]).t;
  const toast = useToast();
  const [testing, setTesting] = createSignal(false);
  const form = createSettingsDraft<HealthWebhookInput>({
    initial: props.webhook ? toInput(props.webhook) : newWebhook(),
    locale,
    // A new alert has nothing stored yet, so it can always be created once its fields are valid.
    pending: () => props.webhook === null,
    validate: (value): Record<string, string> => ({
      ...(value.name.trim() ? {} : { name: t().nameRequired }),
      ...(value.url.trim() ? {} : { url: t().urlRequired }),
    }),
    save: async (value) => {
      const response = props.webhook
        ? await apiClient.health.webhooks[":id"].$put({ param: { id: props.webhook.id }, json: value })
        : await apiClient.health.webhooks.$post({ json: value });
      if (!response.ok)
        throw oneStepFailure(
          response.status,
          (await response.json().catch(() => null)) as { message?: string } | null,
          g().saveWebhookFailed,
        );
      const saved = await readHealthWebhookResponse(response, g().unexpectedWebhookResponse);
      // A created alert opens as itself, so its address names it.
      if (!props.webhook) location.assign(webhookHref(saved.id));
      return toInput(saved);
    },
  });
  const draft = () => form.draft();
  const disabled = () => form.saving();

  const test = async () => {
    if (testing() || !props.webhook) return;
    setTesting(true);
    try {
      const response = await apiClient.health.webhooks[":id"].test.$post({ param: { id: props.webhook.id } });
      if (!response.ok) throw new Error(await responseErrorMessage(response, g().testWebhookFailed));
      toast(g().webhookTestSubmitted, { status: "ok" });
    } catch (error) {
      toast(error instanceof Error ? error.message : g().testWebhookFailed, { status: "bad" });
    } finally {
      setTesting(false);
    }
  };
  const sendLabel = (value: (typeof SEND_ON)[number]) =>
    ({ ok: g().ok, warn: g().warning, error: g().error, recovery: g().recovery, every_check: g().everyCheck })[value];
  const lastSent = () =>
    props.webhook?.lastSentAt
      ? t().lastTest({
          when: formatDateTime(props.webhook.lastSentAt, { locale: locale(), timeZone: props.timeZone }),
          status: props.webhook.lastError ? g().error : g().ok,
        })
      : t().neverSent;

  return (
    <>
      <SettingsOutcome outcome={form.outcome()} onRetry={() => void form.save()} />
      <Show when={props.webhook?.lastError}>
        {(error) => (
          <Notice tone="bad" title={g().error}>
            {error()}
          </Notice>
        )}
      </Show>
      <Band>
        <Check
          switch
          label={g().enabled}
          checked={draft().enabled}
          onChange={(enabled) => form.update({ enabled })}
          disabled={disabled()}
        />
        <Field label={g().name} hint={g().webhookNameDescription} error={form.errors().name}>
          <Input value={draft().name} onInput={(name) => form.update({ name })} disabled={disabled()} />
        </Field>
        <Field label="URL" hint={g().urlDescription} error={form.errors().url}>
          <Input type="url" value={draft().url} onInput={(url) => form.update({ url })} disabled={disabled()} />
        </Field>
        <Field label={g().method} hint={g().methodDescription}>
          <Choice
            name="method"
            options={[
              { value: "GET", label: "GET ping" },
              { value: "POST", label: "POST JSON" },
            ]}
            value={draft().method}
            onChange={(method) => form.update({ method: method === "POST" ? "POST" : "GET" })}
            disabled={disabled()}
          />
        </Field>
      </Band>
      <Band>
        <Field label={g().minimumStatus} hint={g().minimumStatusDescription}>
          <Choice
            name="minStatus"
            options={[
              { value: "ok", label: g().ok },
              { value: "warn", label: g().warning },
              { value: "error", label: g().error },
            ]}
            value={draft().minStatus}
            onChange={(minStatus) => form.update({ minStatus: minStatus === "ok" ? "ok" : minStatus === "warn" ? "warn" : "error" })}
            disabled={disabled()}
          />
        </Field>
        <Field label={g().sendWhen} hint={g().sendWhenDescription}>
          <For each={SEND_ON}>
            {(value) => (
              <Check
                label={sendLabel(value)}
                checked={draft().sendOn.includes(value)}
                onChange={(checked) => form.update({ sendOn: toggle(draft().sendOn, value, checked) })}
                disabled={disabled()}
              />
            )}
          </For>
        </Field>
        <Field label={g().repeatInterval} hint={g().repeatIntervalDescription} optional="min">
          <Input
            type="number"
            min={1}
            value={String(Math.round(draft().repeatIntervalMs / 60_000))}
            onInput={(minutes) => form.update({ repeatIntervalMs: Math.max(1, Number(minutes) || 1) * 60_000 })}
            disabled={disabled()}
          />
        </Field>
      </Band>
      <Band>
        <Field label={g().scope} hint={g().scopeDescription}>
          <Choice
            name="scope"
            options={[
              { value: "all", label: g().allApps },
              { value: "include", label: g().selectedOnly },
              { value: "exclude", label: g().excludeSelected },
            ]}
            value={draft().scopeKind}
            onChange={(scopeKind) =>
              form.update({ scopeKind: scopeKind === "include" ? "include" : scopeKind === "exclude" ? "exclude" : "all" })
            }
            disabled={disabled()}
          />
        </Field>
        <Show when={draft().scopeKind !== "all"}>
          <Field label={g().apps}>
            <For each={props.apps}>
              {(app) => (
                <Check
                  label={app.name}
                  checked={draft().scopeAppIds.includes(app.id)}
                  onChange={(checked) => form.update({ scopeAppIds: toggle(draft().scopeAppIds, app.id, checked) })}
                  disabled={disabled()}
                />
              )}
            </For>
          </Field>
        </Show>
      </Band>
      <Show when={props.webhook}>
        <Bar
          start={
            <Text type="meta" muted>
              {lastSent()}
            </Text>
          }
          end={
            <Button icon="plug" busy={testing()} disabled={form.saving()} onClick={() => void test()}>
              {g().test}
            </Button>
          }
        />
      </Show>
    </>
  );
}
