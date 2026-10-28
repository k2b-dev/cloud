import type { DateContext } from "@k2b/stdlib";
import { Button, ButtonLink, toast, useLocale } from "@k2b/ui";
import { createSignal, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { errorMessage, useChatMessages } from "./chat-dialog";
import { untilLabel } from "./chat-format";
import { type DeviceNotice, deviceNoticeCookie } from "./device-notice";

/** Remembers "Not now" on this device only; another device asks again. */
export const NOTIFICATION_ASK_KEY = "chat:notifications-ask-dismissed";
/** The Help topic that explains notifications, including the Home Screen on iPhone. */
export const NOTIFICATION_HELP_HREF = "/help/apps/chat/chat-notifications";
/** Quiet time can end on its own; the line checks again at least this often while the list is open. */
const RECHECK_MS = 5 * 60_000;

const dismissed = () => {
  try {
    return localStorage.getItem(NOTIFICATION_ASK_KEY) === "1";
  } catch {
    return false;
  }
};

/**
 * One line above the chats about this device: do not disturb with "End", the offer to turn notifications on (once per
 * device), or, on iPhone in Safari, that Cloud needs to be on the Home Screen. At most one shows, always in the same
 * place. The server draws the one this device found last, and the browser checks it again; a new line waits for the
 * next visit, so it never moves the chats.
 */
export default function ChatDeviceNotice(props: { initial: DeviceNotice; dateConfig: DateContext; now: () => Date }): JSX.Element {
  const t = useChatMessages();
  const locale = useLocale();
  const [notice, setNotice] = createSignal<DeviceNotice>(props.initial);
  const [busy, setBusy] = createSignal(false);
  const show = (next: DeviceNotice) => {
    setNotice(next);
    document.cookie = deviceNoticeCookie(next);
  };

  const read = async () => {
    const { browserNotificationClient } = await import("@k2b/cloud/browser/notifications");
    const [quiet, device] = await Promise.all([
      browserNotificationClient.quietState().catch(() => null),
      browserNotificationClient.state().catch(() => null),
    ]);
    // A failed read keeps what shows; only an answer changes it.
    if (!quiet && !device) return;
    const next: DeviceNotice =
      quiet?.active && quiet.reason
        ? { kind: "quiet", reason: quiet.reason, until: quiet.until }
        : device?.homeScreenRequired
          ? { kind: "home-screen" }
          : device?.supported && device.permission === "default" && !dismissed()
            ? { kind: "ask" }
            : { kind: "none" };
    // A line never pushes the chats down after they are shown: an empty place only remembers it for the next visit,
    // where the server draws it in the first picture. A shown line changes or goes away at once.
    if (notice().kind === "none" && next.kind !== "none") document.cookie = deviceNoticeCookie(next);
    else show(next);
  };
  onMount(() => {
    void read().catch(() => {});
    const timer = setInterval(() => void read().catch(() => {}), RECHECK_MS);
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
    show({ kind: "none" });
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
  const quiet = () => {
    const current = notice();
    return current.kind === "quiet" ? current : null;
  };
  const quietLine = (state: { reason: "doNotDisturb" | "quietHours"; until: string | null }) => {
    const until = state.until ? untilLabel(state.until, props.now(), { ...props.dateConfig, locale: locale() }) : null;
    if (state.reason === "quietHours") return until ? t().quietHoursUntil({ time: until }) : t().doNotDisturb;
    return until ? t().doNotDisturbUntil({ time: until }) : t().doNotDisturb;
  };

  return (
    <Switch>
      <Match when={quiet()}>
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
      <Match when={notice().kind === "ask"}>
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
      <Match when={notice().kind === "home-screen"}>
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
