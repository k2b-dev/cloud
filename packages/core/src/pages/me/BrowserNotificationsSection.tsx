import type { BrowserNotificationState } from "@k2b/cloud/browser/notifications";
import { browserNotificationClient } from "@k2b/cloud/browser/notifications";
import { Chip, Notice, Row, Section, useToast } from "@k2b/ui/v2";
import { createSignal, onMount, Show } from "solid-js";
import { useAccountMessages } from "./AccountWorkspace";
import type { AccountMessages } from "./messages";

const localizeBrowserReason = (reason: string, t: AccountMessages, fallback = reason): string => {
  if (reason === "Browser notifications are not supported in this browser.") return t.browserUnsupported;
  if (reason === "On iPhone and iPad, add Cloud to your Home Screen before enabling browser notifications.") return t.iosHomeScreenRequired;
  return fallback;
};

/**
 * Notifications › This browser: turns push notifications on or off for this browser. Only the browser knows its
 * state, so the server's page shows the row with its deed dimmed and without a state word; nothing moves when the
 * browser has answered.
 */
export default function BrowserNotificationsSection() {
  const t = useAccountMessages();
  const toast = useToast();
  const [state, setState] = createSignal<BrowserNotificationState | null>(null);
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  onMount(async () => {
    try {
      setState(await browserNotificationClient.state());
    } catch {
      setState({ supported: false, permission: "default", enabled: false, reason: t().notificationCheckFailed });
    }
  });

  const enable = async () => {
    setPending(true);
    setError(null);
    try {
      const next = await browserNotificationClient.enable();
      setState(next);
      if (next.enabled) toast(t().browserNotificationsEnabled, { status: "ok" });
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
      toast(t().browserNotificationsDisabled, { status: "ok" });
    } catch (cause) {
      setError(cause instanceof Error ? localizeBrowserReason(cause.message, t(), t().browserDisableFailed) : t().browserDisableFailed);
    } finally {
      setPending(false);
    }
  };

  // The state is the chip (on, blocked); the line says what the browser does, or that it cannot.
  const status = () => (state()?.supported === false ? t().unavailable : t().browserNotificationsDescription);
  const usable = () => state()?.supported === true && state()?.permission !== "denied";

  return (
    <Section icon="bell" title={t().browserNotifications}>
      <Row
        mark={{ icon: state()?.enabled ? "bell-ringing" : "bell", color: "#0284c7" }}
        lines={[t().thisBrowser, status()]}
        marks={
          state()?.enabled ? (
            <Chip status="ok">{t().enabled}</Chip>
          ) : state()?.permission === "denied" ? (
            <Chip status="bad">{t().blocked}</Chip>
          ) : undefined
        }
        action={{
          label: pending() ? (state()?.enabled ? t().disabling : t().enabling) : state()?.enabled ? t().disable : t().enable,
          icon: state()?.enabled ? "bell-off" : "bell-plus",
          disabled: !usable() || pending(),
          onClick: () => void (state()?.enabled ? disable() : enable()),
        }}
      />
      <Show when={state()?.reason}>
        {(reason) => (
          <Notice tone="note" icon="info-circle">
            {localizeBrowserReason(reason(), t())}
          </Notice>
        )}
      </Show>
      <Show when={error()}>{(message) => <Notice tone="bad">{message()}</Notice>}</Show>
    </Section>
  );
}
