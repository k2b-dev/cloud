import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Chip,
  confirm,
  Empty,
  Facts,
  Failed,
  List,
  Menu,
  type NavProps,
  Notice,
  Pane,
  RecordHead,
  Row,
  Text,
  useToast,
} from "@k2b/ui/v2";
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
  /** The first alerts in name order; null when they could not be read. */
  webhooks: HealthWebhook[] | null;
  /** More alerts exist than the list shows. */
  more: boolean;
  /** The open alert, read on its own, so one beyond the list opens too. */
  openWebhook: HealthWebhook | null;
  apps: HealthApp[];
  /** The open alert: an id, "new" for the form of a new one, or null. */
  open: string | null;
};

const statusOf = (webhook: HealthWebhook) =>
  !webhook.enabled ? null : webhook.lastError ? ("bad" as const) : webhook.lastStatus === "warn" ? ("warn" as const) : ("ok" as const);

/** The host of a webhook's address, as its short identifier; the address itself when it does not parse. */
const hostOf = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

/** Alerts on v2: the list of health webhooks, the open one (or a new one) beside it. */
export default function SettingsScreen(props: SettingsScreenProps) {
  const locale = useLocale();
  const t = () => areaMessages.resolve([locale()]).t;
  const g = () => gatewayOpsMessages.resolve([locale()]).t;
  const toast = useToast();
  const add = () => ({ label: t().addWebhook, icon: "plus", href: webhookHref("new") });
  const selected = () =>
    props.open && props.open !== "new" ? (props.webhooks?.find((row) => row.id === props.open) ?? props.openWebhook) : null;
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
  const appsOf = (webhook: HealthWebhook) =>
    webhook.scopeKind === "include"
      ? t().appsSelected({ count: webhook.scopeAppIds.length })
      : webhook.scopeKind === "exclude"
        ? t().appsExcept({ count: webhook.scopeAppIds.length })
        : g().allApps;
  const minimumOf = (webhook: HealthWebhook) =>
    webhook.minStatus === "ok" ? g().ok : webhook.minStatus === "warn" ? g().warning : g().error;
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
            <Button variant={props.open ? undefined : "primary"} floats={!props.open} icon="plus" href={webhookHref("new")}>
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
                <Show when={props.more}>
                  <Text type="meta" muted>
                    {t().alertsFirst({ count: webhooks().length })}
                  </Text>
                </Show>
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
                start={
                  // k2b-ui gap: tinted object head (look.md rule 5); until it lands the open alert names itself and its host
                  <Show when={selected()} fallback={<Text type="lead">{t().addWebhook}</Text>}>
                    {(webhook) => <RecordHead name={webhook().name} ids={[{ value: hostOf(webhook().url), icon: "link" }]} />}
                  </Show>
                }
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
              <Show when={selected()}>
                {(webhook) => (
                  <>
                    {/* a problem stands first, in red, with the reason the target gave */}
                    <Show when={webhook().enabled && webhook().lastError}>
                      {(error) => (
                        <Notice tone="bad" title={t().alertFailing}>
                          {error()}
                        </Notice>
                      )}
                    </Show>
                    <Facts
                      inline
                      items={[
                        { label: g().apps, value: appsOf(webhook()) },
                        { label: g().minimumStatus, value: minimumOf(webhook()) },
                        { label: g().method, value: webhook().method },
                      ]}
                    />
                  </>
                )}
              </Show>
              <WebhookForm webhook={selected()} apps={props.apps} timeZone={props.timeZone} />
            </Show>
          </Pane>
        </Show>
      </Pane.Split>
    </AdminWorkspace>
  );
}
