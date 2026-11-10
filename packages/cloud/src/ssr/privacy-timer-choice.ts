import { toast } from "@k2b/ui";
import { createSignal, onCleanup, onMount } from "solid-js";
import { announceSavedPrivacyTimer, onPrivacyTimer, savePrivacyTimer } from "../browser/privacy-timer";
import { PRIVACY_TIMER_CHOICES, type PrivacyTimerSeconds } from "../contracts/screen-preferences";
import { privacyScreenMessages, privacyTimerLabel } from "./privacy-screen-messages";

/**
 * The privacy screen's timer as the profile menu and the settings page offer it. A choice shows at once; when the
 * server does not save it, the previous value returns and a message offers to try again. Saves run one after another
 * and only the last choice is sent once the running save ends, so the server and every tab end at the last choice.
 */
export function createPrivacyTimerChoice(initial: PrivacyTimerSeconds, locale: () => string) {
  const [value, setValue] = createSignal(initial);
  const [failed, setFailed] = createSignal<PrivacyTimerSeconds | null>(null);
  const [saved, setSaved] = createSignal(false);
  let confirmed = initial;
  let pending: { seconds: PrivacyTimerSeconds; toast: boolean } | null = null;
  let saving = false;
  const t = () => privacyScreenMessages.resolve([locale()]).t;
  onMount(() =>
    onCleanup(
      onPrivacyTimer((seconds) => {
        confirmed = seconds;
        if (!saving && pending === null) setValue(seconds);
      }),
    ),
  );
  const flush = async () => {
    saving = true;
    while (pending) {
      const { seconds, toast: tell } = pending;
      pending = null;
      const ok = await savePrivacyTimer(seconds);
      if (ok) confirmed = seconds;
      // A newer choice waits; it decides what the page shows and what the other tabs hear.
      if (pending) continue;
      saving = false;
      if (ok) {
        announceSavedPrivacyTimer(seconds);
        setSaved(true);
        return;
      }
      setValue(confirmed);
      setFailed(seconds);
      if (tell) {
        toast.error(t().timerNotSaved({ value: privacyTimerLabel(t(), confirmed) }), {
          action: { label: t().retry, onClick: () => choose(seconds) },
        });
      }
      return;
    }
    saving = false;
  };
  const choose = (next: PrivacyTimerSeconds, options: { toast?: boolean } = {}) => {
    setValue(next);
    setFailed(null);
    setSaved(false);
    pending = { seconds: next, toast: options.toast ?? true };
    if (!saving) void flush();
  };
  const options = () => PRIVACY_TIMER_CHOICES.map((seconds) => ({ value: String(seconds), label: privacyTimerLabel(t(), seconds) }));
  return { value, choose, failed, saved, options, messages: t };
}

export const parsePrivacyTimer = (value: string): PrivacyTimerSeconds | undefined =>
  PRIVACY_TIMER_CHOICES.find((seconds) => String(seconds) === value);

export { requestPrivacyScreen } from "../browser/privacy-timer";
export { PRIVACY_SHORTCUT } from "./privacy-screen-constants";
