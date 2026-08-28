import { Button, toast, useLocale } from "@k2b/ui";
import type { BrowserNotificationState } from "@valentinkolb/cloud/browser/notifications";
import { browserNotificationClient } from "@valentinkolb/cloud/browser/notifications";
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
    <section class="paper p-5 sm:p-6">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex min-w-0 items-start gap-3">
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-blue-500/10 text-blue-600 dark:bg-blue-400/15 dark:text-blue-400">
            <i class="ti ti-bell" />
          </span>
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="text-sm font-semibold text-primary">{t().browserNotifications}</h2>
              <span class={`tag ${status().class}`}>{status().label}</span>
            </div>
            <p class="mt-1 text-xs leading-relaxed text-dimmed">{t().browserNotificationsDescription}</p>
            <Show when={state()?.reason} keyed>
              {(reason) => <p class="mt-2 text-xs text-secondary">{localizeBrowserReason(reason, t())}</p>}
            </Show>
            <Show when={error()} keyed>
              {(message) => <p class="mt-2 text-xs text-red-600 dark:text-red-400">{message}</p>}
            </Show>
          </div>
        </div>

        <Show when={state()?.supported && state()?.permission !== "denied"}>
          <Button
            type="button"
            variant={state()?.enabled ? "secondary" : "primary"}
            size="sm"
            class="shrink-0"
            loading={pending()}
            loadingLabel={state()?.enabled ? t().disabling : t().enabling}
            onClick={() => void (state()?.enabled ? disable() : enable())}
          >
            <i class={pending() ? "ti ti-loader-2 animate-spin" : state()?.enabled ? "ti ti-bell-off" : "ti ti-bell-plus"} />
            {pending() ? t().working : state()?.enabled ? t().disable : t().enable}
          </Button>
        </Show>
      </div>
    </section>
  );
}

const localizeBrowserReason = (reason: string, t: AccountMessages, fallback = reason): string => {
  if (reason === "Browser notifications are not supported in this browser.") return t.browserUnsupported;
  if (reason === "On iPhone and iPad, add Cloud to your Home Screen before enabling browser notifications.") return t.iosHomeScreenRequired;
  return fallback;
};
