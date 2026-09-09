import type { NotificationDeliveryStatus } from "@k2b/cloud/contracts";
import { accountMessages } from "./messages";

export type NotificationChannelAvailability = {
  enabled: boolean;
  description?: string;
};

export const notificationChannelAvailability = (registered: boolean, locale?: string): NotificationChannelAvailability => {
  if (!registered) return { enabled: false, description: accountMessages.resolve([locale ?? "en"]).t.channelUnavailable };
  return { enabled: true };
};

export const notificationChannelMeta = (channel: string, locale?: string): { label: string; icon: string } => {
  const { t } = accountMessages.resolve([locale ?? "en"]);
  const channels: Record<string, { label: string; icon: string }> = {
    email: { label: t.channelEmail, icon: "ti ti-mail" },
    browser: { label: t.channelBrowser, icon: "ti ti-bell" },
    none: { label: t.channelNone, icon: "ti ti-bell-off" },
  };
  return (
    channels[channel] ?? {
      label: channel
        .split(/[-_.:]/)
        .filter(Boolean)
        .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
        .join(" "),
      icon: "ti ti-bell",
    }
  );
};

export const notificationStatusMeta = (status: NotificationDeliveryStatus, locale?: string): { label: string; class: string } => {
  const { t } = accountMessages.resolve([locale ?? "en"]);
  switch (status) {
    case "delivered":
      return { label: t.delivered, class: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" };
    case "failed":
      return { label: t.failed, class: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300" };
    case "suppressed":
      return { label: t.notSent, class: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" };
    case "sending":
      return { label: t.sending, class: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" };
    case "pending":
      return { label: t.pending, class: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" };
    case "deferred":
      return { label: t.waiting, class: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300" };
  }
};

export const notificationErrorText = (errorCode: string | null, errorMessage: string | null, locale?: string): string | null => {
  if (!errorCode && !errorMessage) return null;
  const resolved = accountMessages.resolve([locale ?? "en"]);
  const messages: Record<string, string> = {
    preparation_failed: resolved.t.deliveryPreparationFailed,
    channel_unavailable: resolved.t.deliveryChannelUnavailable,
    no_endpoint: resolved.t.deliveryEndpointMissing,
    disabled_by_user: resolved.t.deliveryDisabledByUser,
    no_preferred_channel: resolved.t.deliveryPreferenceMissing,
    provider_error: resolved.t.deliveryProviderFailed,
  };
  return (
    (errorCode ? messages[errorCode] : undefined) ?? (resolved.locale === "en" ? errorMessage : null) ?? resolved.t.deliveryFailedGeneric
  );
};
