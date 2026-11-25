import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Chip, confirm, Empty, Failed, List, Menu, type NavProps, Pane, Row, Tabs, Text, useToast } from "@k2b/ui/v2";
import { For, type JSX, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import { type HealthApp, type HealthWebhook, responseErrorMessage } from "../../../frontend/health-webhook-queries";
import { gatewayOpsMessages } from "../../../messages";
import { afterMenu } from "../../_components/after-menu";
import { areaMessages } from "../../_components/area-messages";
import { SettingsSaveBar } from "../../_components/SettingsSaveBar";
import HealthCheckForm, { type HealthCheckValues } from "../HealthCheckForm";
import RetentionForm, { type RetentionValues } from "../RetentionForm";
import WebhookForm, { ALERTS_PATH, webhookHref } from "../WebhookForm";

export const SETTINGS_HREF = {
  alerts: ALERTS_PATH,
  health: "/admin/observability/settings/health-check",
  retention: "/admin/observability/settings/retention",
} as const;

export type SettingsScreenProps = { nav: NavProps; timeZone: string } & (
  | {
      area: "alerts";
      webhooks: HealthWebhook[] | null;
      apps: HealthApp[];
      /** The open alert: an id, "new" for the form of a new one, or null. */
      open: string | null;
    }
  | { area: "health"; values: HealthCheckValues; unreadable: Partial<Record<keyof HealthCheckValues, boolean>> }
  | { area: "retention"; values: RetentionValues; unreadable: Partial<Record<keyof RetentionValues, boolean>> }
);

/** Observability settings on v2: alerts, the health check and retention, each an area of one record. */
export default function SettingsScreen(props: SettingsScreenProps) {
  const locale = useLocale();
  const t = () => areaMessages.resolve([locale()]).t;
  const tabs = () => (
    <Tabs
      label={t().settings}
      items={[
        { label: t().alertsShort, icon: "webhook", href: SETTINGS_HREF.alerts, current: props.area === "alerts" },
        { label: t().healthCheckShort, icon: "heart-rate-monitor", href: SETTINGS_HREF.health, current: props.area === "health" },
        { label: t().retention, icon: "archive", href: SETTINGS_HREF.retention, current: props.area === "retention" },
      ]}
    />
  );
  // The area is fixed for a page, so the screen picks its shape once.
  if (props.area === "alerts") return <AlertsArea {...props} tabs={tabs()} />;
  return <FormArea {...props} tabs={tabs()} />;
}

/** Health check or retention: one form, saved from the head. */
function FormArea(props: Exclude<SettingsScreenProps, { area: "alerts" }> & { tabs: JSX.Element }) {
  const locale = useLocale();
  const t = () => areaMessages.resolve([locale()]).t;
  return (
    <AdminWorkspace nav={props.nav} head={<Bar start={props.tabs} end={<SettingsSaveBar />} />}>
      <Pane label={props.area === "health" ? t().healthCheck : t().retention}>
        <Text type="body" muted>
          {props.area === "health" ? t().healthCheckDescription : t().retentionDescription}
        </Text>
        {props.area === "health" ? (
          <HealthCheckForm values={props.values} unreadable={props.unreadable} />
        ) : (
          <RetentionForm values={props.values} unreadable={props.unreadable} />
        )}
      </Pane>
    </AdminWorkspace>
  );
}

const statusOf = (webhook: HealthWebhook) =>
  !webhook.enabled ? null : webhook.lastError ? ("bad" as const) : webhook.lastStatus === "warn" ? ("warn" as const) : ("ok" as const);

/** The alerts as a list, the open one (or a new one) beside it. */
function AlertsArea(props: Extract<SettingsScreenProps, { area: "alerts" }> & { tabs: JSX.Element }) {
  const locale = useLocale();
  const t = () => areaMessages.resolve([locale()]).t;
  const g = () => gatewayOpsMessages.resolve([locale()]).t;
  const toast = useToast();
  const add = () => ({ label: t().addWebhook, icon: "plus", href: webhookHref("new") });
  const selected = () => (props.open && props.open !== "new" ? (props.webhooks?.find((row) => row.id === props.open) ?? null) : null);
  const remove = async (webhook: HealthWebhook) => {
    if (
      !(await confirm({
        title: g().deleteWebhookTitle,
        description: g().deleteWebhookConfirm({ name: webhook.name }),
        confirm: t().deleteAlert,
      }))
    )
      return;
    const response = await apiClient.health.webhooks[":id"].$delete({ param: { id: webhook.id } });
    if (!response.ok) {
      toast(await responseErrorMessage(response, g().deleteWebhookFailed), { status: "bad" });
      return;
    }
    location.assign(ALERTS_PATH);
  };
  const statusWord = (webhook: HealthWebhook) => {
    const status = statusOf(webhook);
    return status === null ? g().disabled : status === "bad" ? g().error : status === "warn" ? g().warning : g().ok;
  };
  return (
    <AdminWorkspace
      nav={props.nav}
      detail={props.open ? 480 : undefined}
      primary={props.open ? undefined : add()}
      head={
        <Bar
          start={props.tabs}
          end={
            <Button variant={props.open ? undefined : "primary"} icon="plus" href={webhookHref("new")}>
              {t().addWebhook}
            </Button>
          }
        />
      }
    >
      <Pane.Split>
        <Pane label={t().alerts} width={{ min: 300, default: 380 }}>
          <Show
            when={props.webhooks}
            fallback={<Failed text={`${t().loadFailed} ${t().loadFailedKeep}`} onRetry={() => location.reload()} />}
          >
            {(webhooks) => (
              <Show when={webhooks().length > 0} fallback={<Empty icon="webhook" text={t().noWebhooksDetail} action={add()} />}>
                <List label={t().alerts}>
                  <For each={webhooks()}>
                    {(webhook) => (
                      <Row
                        icon="webhook"
                        lines={[webhook.name, webhook.lastError ?? webhook.url]}
                        current={webhook.id === props.open}
                        href={webhookHref(webhook.id)}
                        end={(() => {
                          const status = statusOf(webhook);
                          return status ? <Chip status={status}>{statusWord(webhook)}</Chip> : <Chip>{statusWord(webhook)}</Chip>;
                        })()}
                      />
                    )}
                  </For>
                </List>
              </Show>
            )}
          </Show>
        </Pane>
        <Show when={props.open}>
          <Pane
            detail
            label={selected()?.name ?? t().addWebhook}
            back={{ label: t().alerts, href: ALERTS_PATH }}
            head={
              <Bar
                start={<Text type="lead">{selected()?.name ?? t().addWebhook}</Text>}
                end={
                  <>
                    <Show when={props.open === "new" || selected()}>
                      <SettingsSaveBar primary={false} />
                    </Show>
                    <Show when={selected()}>
                      {(webhook) => (
                        <Menu
                          label={g().actions}
                          items={[{ label: t().deleteAlert, icon: "trash", danger: true, onClick: afterMenu(() => remove(webhook())) }]}
                        />
                      )}
                    </Show>
                    <Button variant="ghost" icon="x" label={g().close} href={ALERTS_PATH} />
                  </>
                }
              />
            }
          >
            <Show
              when={props.open === "new" || selected()}
              fallback={
                <Empty
                  icon="webhook-off"
                  text={`${t().webhookGone}. ${t().webhookGoneDetail}`}
                  action={{ label: t().alerts, href: ALERTS_PATH }}
                />
              }
            >
              <WebhookForm webhook={selected()} apps={props.apps} timeZone={props.timeZone} />
            </Show>
          </Pane>
        </Show>
      </Pane.Split>
    </AdminWorkspace>
  );
}
