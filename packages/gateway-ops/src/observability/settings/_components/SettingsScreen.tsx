import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Chip, confirm, Empty, Failed, List, Menu, type NavProps, Pane, Row, Text, useToast } from "@k2b/ui/v2";
import { For, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import { type HealthApp, type HealthWebhook, responseErrorMessage } from "../../../frontend/health-webhook-queries";
import { gatewayOpsMessages } from "../../../messages";
import { afterMenu } from "../../_components/after-menu";
import { areaMessages } from "../../_components/area-messages";
import { SettingsSaveBar } from "../../_components/SettingsSaveBar";
import WebhookForm, { ALERTS_PATH, webhookHref } from "../WebhookForm";
import { SettingsTabs } from "./SettingsTabs";

export type SettingsScreenProps = {
  nav: NavProps;
  timeZone: string;
  webhooks: HealthWebhook[] | null;
  apps: HealthApp[];
  /** The open alert: an id, "new" for the form of a new one, or null. */
  open: string | null;
};

const statusOf = (webhook: HealthWebhook) =>
  !webhook.enabled ? null : webhook.lastError ? ("bad" as const) : webhook.lastStatus === "warn" ? ("warn" as const) : ("ok" as const);

/** Alerts on v2: the list of health webhooks, the open one (or a new one) beside it. */
export default function SettingsScreen(props: SettingsScreenProps) {
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
          start={<SettingsTabs current="alerts" />}
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
