import type { NotificationQuietState } from "@k2b/cloud/contracts";
import type { DateContext } from "@k2b/stdlib";
import { Button, ButtonLink, toast, useLocale } from "@k2b/ui";
import { createSignal, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { errorMessage, useChatMessages } from "./chat-dialog";
import { untilLabel } from "./chat-format";

/** Remembers "Not now" on this device only; another device asks again. */
export const NOTIFICATION_ASK_KEY = "chat:notifications-ask-dismissed";
/** The Help topic that explains notifications, including the Home Screen on iPhone. */
export const NOTIFICATION_HELP_HREF = "/help/apps/chat/chat-notifications";
/** Quiet time can end on its own; the line checks again at least this often while the list is open. */
const QUIET_RECHECK_MS = 5 * 60_000;

type Notice = "quiet" | "ask" | "home-screen" | "none";

const dismissed = () => {
  try {
    return localStorage.getItem(NOTIFICATION_ASK_KEY) === "1";
  } catch {
    return false;
  }
};

/**
 * One line above the chats about this device: do not disturb with "End", the offer to turn notifications on (once per
 * device), or, on iPhone in Safari, that Cloud needs to be on the Home Screen. Only the browser knows these, so the line
 * appears after the list mounts, at most one at a time, and in the same place every time.
 */
export default function ChatDeviceNotice(props: { dateConfig: DateContext; now: () => Date }): JSX.Element {
  const t = useChatMessages();
  const locale = useLocale();
  const [notice, setNotice] = createSignal<Notice>("none");
  const [quiet, setQuiet] = createSignal<NotificationQuietState | null>(null);
  const [busy, setBusy] = createSignal(false);

  const read = async () => {
    const { browserNotificationClient } = await import("@k2b/cloud/browser/notifications");
    const [quiet, device] = await Promise.all([
      browserNotificationClient.quietState().catch(() => null),
      browserNotificationClient.state().catch(() => null),
    ]);
    setQuiet(quiet?.active ? quiet : null);
    setNotice(
      quiet?.active
        ? "quiet"
        : device?.homeScreenRequired
          ? "home-screen"
          : device?.supported && device.permission === "default" && !dismissed()
            ? "ask"
            : "none",
    );
  };
  onMount(() => {
    void read().catch(() => {});
    const timer = setInterval(() => void read().catch(() => {}), QUIET_RECHECK_MS);
    onCleanup(() => clearInterval(timer));
  });

  const enable = async () => {
    setBusy(true);
    try {
      const { browserNotificationClient } = await import("@k2b/cloud/browser/notifications");
      await browserNotificationClient.enable();
      await read();
    } catch (failure) {
      toast.error(errorMessage(failure, t().enableFailed));
    } finally {
      setBusy(false);
    }
  };
  const notNow = () => {
    try {
      localStorage.setItem(NOTIFICATION_ASK_KEY, "1");
    } catch {
      // Without storage the offer simply returns on the next visit.
    }
    setNotice("none");
  };
  const endQuiet = async () => {
    setBusy(true);
    try {
      const { browserNotificationClient } = await import("@k2b/cloud/browser/notifications");
      await browserNotificationClient.endDoNotDisturb();
      await read();
    } catch {
      toast.error(t().endDoNotDisturbFailed);
    } finally {
      setBusy(false);
    }
  };
  const quietLine = (state: NotificationQuietState) => {
    const until = state.until ? untilLabel(state.until, props.now(), { ...props.dateConfig, locale: locale() }) : null;
    if (state.reason === "quietHours") return until ? t().quietHoursUntil({ time: until }) : t().doNotDisturb;
    return until ? t().doNotDisturbUntil({ time: until }) : t().doNotDisturb;
  };

  return (
    <Switch>
      <Match when={notice() === "quiet" && quiet()}>
        {(state) => (
          <div class="chat-device-notice" data-kind="quiet">
            <i class="ti ti-moon" aria-hidden="true" />
            <span class="chat-device-notice__text">{quietLine(state())}</span>
            {/* Quiet hours follow their schedule; only a do-not-disturb pause ends here. */}
            <Show when={state().reason === "doNotDisturb"}>
              <Button variant="text" size="xs" loading={busy()} onClick={() => void endQuiet()}>
                {t().endDoNotDisturb}
              </Button>
            </Show>
          </div>
        )}
      </Match>
      <Match when={notice() === "ask"}>
        <div class="chat-device-notice" data-kind="ask">
          <i class="ti ti-bell" aria-hidden="true" />
          <div class="chat-device-notice__body">
            <span class="chat-device-notice__text">{t().enableAsk}</span>
            <div class="chat-device-notice__actions">
              <Button variant="primary" size="xs" loading={busy()} onClick={() => void enable()}>
                {t().enableNotifications}
              </Button>
              <Button variant="secondary" size="xs" disabled={busy()} onClick={notNow}>
                {t().notNow}
              </Button>
            </div>
          </div>
        </div>
      </Match>
      <Match when={notice() === "home-screen"}>
        <div class="chat-device-notice" data-kind="home-screen">
          <i class="ti ti-device-mobile" aria-hidden="true" />
          <div class="chat-device-notice__body">
            <span class="chat-device-notice__text">{t().iphoneHint}</span>
            <div class="chat-device-notice__actions">
              <ButtonLink href={NOTIFICATION_HELP_HREF} variant="text" size="xs">
                {t().howItWorks}
              </ButtonLink>
            </div>
          </div>
        </div>
      </Match>
    </Switch>
  );
}
