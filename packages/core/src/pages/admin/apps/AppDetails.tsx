import type { AppAccessEditorProps } from "@k2b/cloud/access/ui";
import type { AppDetails as Details } from "@k2b/cloud/contracts";
import { appAccentStyle } from "@k2b/cloud/ssr/app-appearance";
import { ButtonLink, Format, IconButtonLink, Placeholder, SettingsSection, StatusBadge, useLocale } from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";
import Access from "./Access.island";
import { appDetailsMessages } from "./messages";
import Redeliver from "./Redeliver.island";

type Hearing = Details["hears"][number];

/** One app as an administrator sees it: who uses it, what it hears and sends, and what it notifies about. */
export default function AppDetails(props: {
  app: Details["app"];
  /** Null when Core could not read the app's events and notifications; access stays usable. */
  details: Details | null;
  /** Display names of known apps by ID, for publishers of heard events. */
  appNames: ReadonlyMap<string, string>;
  /** The access rule as one phrase, in the same words as the app list; shown when it is not configurable here. */
  rule: string;
  /** The access editor when the app's rule is configurable here. */
  access?: AppAccessEditorProps;
  backLabel: string;
  /** "Who uses <app>", the heading the access editor carries itself. */
  accessLabel: string;
}) {
  const locale = useLocale();
  const t = () => appDetailsMessages.resolve([locale()]).t;
  const app = () => props.app;
  const permissionLabel = (permission: string): string => {
    const labels: Readonly<Record<string, string>> = {
      "mail:send": t().permissionMailSend,
      "mail:read": t().permissionMailRead,
      "resources:readers": t().permissionResourceReaders,
    };
    return Object.hasOwn(labels, permission) ? labels[permission]! : permission;
  };
  const time = (value: string | null) =>
    value ? new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "";
  const reason = (code: string | null) => {
    switch (code) {
      case null:
        return null;
      case "resource_events_unsupported":
        return t().reasonResourceEvents;
      case "event_not_declared":
        return t().reasonNotDeclared;
      case "subscription_removed":
        return t().reasonRemoved;
      default:
        return code;
    }
  };
  const state = (hearing: Hearing) =>
    hearing.state === "active"
      ? null
      : {
          tone: hearing.state === "blocked" ? ("warning" as const) : ("neutral" as const),
          label: hearing.state === "blocked" ? t().blocked : t().cancelled,
        };
  const counts = (hearing: Hearing) =>
    [
      hearing.counts.done ? t().delivered({ count: hearing.counts.done }) : null,
      hearing.counts.pending + hearing.counts.retrying ? t().waiting({ count: hearing.counts.pending + hearing.counts.retrying }) : null,
      hearing.counts.failed ? t().failed({ count: hearing.counts.failed }) : null,
    ].filter((part): part is string => part !== null);
  const more = (shown: number, total: number, hint: (count: number) => string) => (
    <Show when={total > shown}>
      <p class="text-[13px] text-dimmed">{hint(total - shown)}</p>
    </Show>
  );
  const empty = (items: readonly unknown[], children: JSX.Element) => (
    <Show when={items.length > 0} fallback={<p class="text-sm text-secondary">{t().none}</p>}>
      {children}
    </Show>
  );
  return (
    <div class="flex w-full max-w-[900px] flex-col gap-8">
      <header class="flex flex-col gap-2">
        <div class="flex min-w-0 items-center gap-3">
          <IconButtonLink href="/admin/apps" variant="ghost" style={{ width: "36px", "min-height": "36px" }} label={props.backLabel}>
            <i class="ti ti-arrow-left" />
          </IconButtonLink>
          <span
            class="app-accent-scope k2b-icon-tile app-accent-text flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
            style={appAccentStyle(app().accent ?? undefined)}
            aria-hidden="true"
          >
            <i class={app().icon ?? "ti ti-apps"} />
          </span>
          <h1 class="min-w-0 truncate text-lg font-semibold sm:text-xl">{app().name}</h1>
          <Show when={!app().online}>
            <StatusBadge tone="neutral" label={t().offline} />
          </Show>
        </div>
        <Show when={app().description}>
          <p class="max-w-[720px] text-sm text-secondary">{app().description}</p>
        </Show>
        <Show when={props.details}>
          {(details) => (
            <p class="text-[13px]">
              <span class="text-dimmed">{t().platformServices}: </span>
              {details().access.platformPermissions.length
                ? details().access.platformPermissions.map(permissionLabel).join(", ")
                : t().noPlatformServices}
            </p>
          )}
        </Show>
        <Show when={!app().online}>
          <p class="max-w-[720px] text-[13px] text-dimmed">{t().offlineHint}</p>
        </Show>
      </header>

      <Show
        when={props.access}
        fallback={
          <SettingsSection title={props.accessLabel} icon="ti ti-lock">
            <p class="text-sm text-secondary">{props.rule}</p>
          </SettingsSection>
        }
      >
        {(editor) => <Access {...editor()} />}
      </Show>

      <Show
        when={props.details}
        fallback={
          <Placeholder
            state="error"
            variant="panel"
            title={t().detailsFailed}
            action={
              <ButtonLink size="sm" variant="secondary" href={`/admin/apps?app=${encodeURIComponent(app().id)}`}>
                {t().reload}
              </ButtonLink>
            }
          />
        }
      >
        {(details) => (
          <>
            <SettingsSection title={t().hears} subtitle={t().hearsHint} icon="ti ti-ear">
              {empty(
                details().hears,
                <ul class="m-0 flex list-none flex-col gap-3 p-0">
                  <For each={details().hears}>
                    {(hearing) => (
                      <li class="flex min-w-0 flex-col gap-1">
                        <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                          <span class="min-w-0 truncate text-sm font-medium">{hearing.title ?? hearing.eventType}</span>
                          <Show when={hearing.isNew}>
                            <StatusBadge tone="info" icon={null} label={t().new} />
                          </Show>
                          <Show when={state(hearing)}>{(badge) => <StatusBadge tone={badge().tone} label={badge().label} />}</Show>
                        </span>
                        <span class="text-[13px] text-dimmed">
                          <code>{`${hearing.eventType} v${hearing.version}`}</code>
                          {` · ${t().from({ app: props.appNames.get(hearing.publisherAppId) ?? hearing.publisherAppId })}`}
                          <For each={counts(hearing)}>{(part) => ` · ${part}`}</For>
                        </span>
                        <Show when={hearing.state !== "active" && reason(hearing.reason)}>
                          <span class="text-[13px] text-secondary">{reason(hearing.reason)}</span>
                        </Show>
                        <Show when={hearing.failedDeliveries.length > 0}>
                          <ul class="m-0 mt-1 flex list-none flex-col gap-2 p-0 pl-4">
                            <For each={hearing.failedDeliveries}>
                              {(delivery) => (
                                <li class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                                  <StatusBadge tone="error" label={t().failedState} />
                                  <span class="text-dimmed">
                                    <Show when={delivery.code}>{(code) => <code>{`${code()} · `}</code>}</Show>
                                    <Show when={delivery.lastAttemptAt}>{(at) => <Format.DateTime value={at()} />}</Show>
                                    {` · ${t().attempts({ count: delivery.attempts })}`}
                                  </span>
                                  <Show when={hearing.state === "active"}>
                                    <Redeliver
                                      id={delivery.id}
                                      label={t().redeliverLabel({
                                        event: hearing.title ?? hearing.eventType,
                                        time: time(delivery.lastAttemptAt),
                                      })}
                                    />
                                  </Show>
                                  <Show when={delivery.lastError}>
                                    <span class="basis-full break-words text-secondary">{delivery.lastError}</span>
                                  </Show>
                                </li>
                              )}
                            </For>
                          </ul>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>,
              )}
              {more(details().hears.length, details().totals.hears, (count) => t().moreHears({ count, app: app().id }))}
            </SettingsSection>

            <SettingsSection title={t().sends} subtitle={t().sendsHint} icon="ti ti-broadcast">
              {empty(
                details().sends,
                <ul class="m-0 flex list-none flex-col gap-3 p-0">
                  <For each={details().sends}>
                    {(event) => (
                      <li class="flex min-w-0 flex-col gap-1">
                        <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                          <span class="min-w-0 truncate text-sm font-medium">{event.title}</span>
                          <Show when={event.place}>
                            <StatusBadge tone="neutral" icon={null} label={t().resourceEvent} />
                          </Show>
                          <Show when={!event.automation}>
                            <StatusBadge tone="neutral" icon={null} label={t().noAutomation} />
                          </Show>
                        </span>
                        <span class="text-[13px] text-dimmed">
                          <code>{`${event.type} v${event.version}`}</code>
                          {` · ${t().subscribers({ count: event.subscriberCount })}`}
                        </span>
                        <Show when={event.description}>
                          <span class="text-[13px] text-secondary">{event.description}</span>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>,
              )}
              {more(details().sends.length, details().totals.sends, (count) => t().moreHint({ count }))}
            </SettingsSection>

            <SettingsSection title={t().notifications} subtitle={t().notificationsHint} icon="ti ti-bell">
              {empty(
                details().notifications,
                <ul class="m-0 flex list-none flex-col gap-3 p-0">
                  <For each={details().notifications}>
                    {(notification) => (
                      <li class="flex min-w-0 flex-col gap-1">
                        <span class="text-sm font-medium">{notification.label}</span>
                        <Show when={notification.description}>
                          <span class="text-[13px] text-secondary">{notification.description}</span>
                        </Show>
                        <span class="text-[13px] text-dimmed">
                          {[
                            notification.recipientKind === "email" ? t().toEmail : null,
                            notification.requiredChannels.length
                              ? t().required({ channels: notification.requiredChannels.join(", ") })
                              : null,
                            notification.excludedChannels.length
                              ? t().excluded({ channels: notification.excludedChannels.join(", ") })
                              : null,
                            notification.recommendedChannels.length
                              ? t().recommended({ channels: notification.recommendedChannels.join(", ") })
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </li>
                    )}
                  </For>
                </ul>,
              )}
              {more(details().notifications.length, details().totals.notifications, (count) => t().moreHint({ count }))}
            </SettingsSection>
          </>
        )}
      </Show>
    </div>
  );
}
