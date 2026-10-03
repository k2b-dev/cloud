import type { BrowserNotificationState } from "@k2b/cloud/browser/notifications";
import { browserNotificationClient } from "@k2b/cloud/browser/notifications";
import { Button, InlineGuidance, SettingsSection, toast, useLocale } from "@k2b/ui";
import { createSignal, onMount, Show } from "solid-js";
import { type AccountMessages, accountMessages } from "./messages";

const statusMeta = (state: BrowserNotificationState | null, t: AccountMessages) => {
  if (!state) return { label: t.checking, class: "tag-neutral" };
  if (!state.supported) return { label: t.unavailable, class: "tag-neutral" };
  if (state.permission === "denied") return { label: t.blocked, class: "tag-danger" };
  if (state.enabled) return { label: t.enabled, class: "tag-success" };
  return { label: t.off, class: "tag-neutral" };
};

export default function BrowserNotificationSetup() {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const [state, setState] = createSignal<BrowserNotificationState | null>(null);
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  onMount(async () => {
    try {
      setState(await browserNotificationClient.state());
    } catch {
      setState({
        supported: false,
        permission: "default",
        enabled: false,
        reason: t().notificationCheckFailed,
      });
    }
  });

  const enable = async () => {
    setPending(true);
    setError(null);
    try {
      const next = await browserNotificationClient.enable();
      setState(next);
      if (next.enabled) toast.success(t().browserNotificationsEnabled);
      else if (next.permission === "denied") setError(t().browserPermissionBlocked);
    } catch (cause) {
      setError(cause instanceof Error ? localizeBrowserReason(cause.message, t(), t().browserEnableFailed) : t().browserEnableFailed);
    } finally {
      setPending(false);
    }
  };

  const disable = async () => {
    setPending(true);
    setError(null);
    try {
      setState(await browserNotificationClient.disable());
      toast.success(t().browserNotificationsDisabled);
    } catch (cause) {
      setError(cause instanceof Error ? localizeBrowserReason(cause.message, t(), t().browserDisableFailed) : t().browserDisableFailed);
    } finally {
      setPending(false);
    }
  };

  const status = () => statusMeta(state(), t());

  return (
    <SettingsSection
      title={t().browserNotifications}
      subtitle={t().browserNotificationsDescription}
      icon="ti ti-bell"
      actions={
        <>
          <span class={`tag ${status().class}`}>{status().label}</span>
          <Show when={state()?.supported && state()?.permission !== "denied"}>
            <Button
              type="button"
              variant={state()?.enabled ? "secondary" : "primary"}
              size="sm"
              loading={pending()}
              loadingLabel={state()?.enabled ? t().disabling : t().enabling}
              onClick={() => void (state()?.enabled ? disable() : enable())}
            >
              <i class={pending() ? "ti ti-loader-2 animate-spin" : state()?.enabled ? "ti ti-bell-off" : "ti ti-bell-plus"} />
              {pending() ? t().working : state()?.enabled ? t().disable : t().enable}
            </Button>
          </Show>
        </>
      }
    >
      <Show when={state()?.reason} keyed>
        {(reason) => (
          <InlineGuidance tone="info" icon="ti ti-info-circle">
            {localizeBrowserReason(reason, t())}
          </InlineGuidance>
        )}
      </Show>
      <Show when={error()} keyed>
        {(message) => (
          <InlineGuidance tone="danger" icon="ti ti-alert-circle" role="alert">
            {message}
          </InlineGuidance>
        )}
      </Show>
    </SettingsSection>
  );
}

const localizeBrowserReason = (reason: string, t: AccountMessages, fallback = reason): string => {
  if (reason === "Browser notifications are not supported in this browser.") return t.browserUnsupported;
  if (reason === "On iPhone and iPad, add Cloud to your Home Screen before enabling browser notifications.") return t.iosHomeScreenRequired;
  return fallback;
};
