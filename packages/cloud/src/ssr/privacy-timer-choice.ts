import { toast } from "@k2b/ui";
import { createSignal, onCleanup, onMount } from "solid-js";
import { onPrivacyTimer, savePrivacyTimer } from "../browser/privacy-timer";
import { PRIVACY_TIMER_CHOICES, type PrivacyTimerSeconds } from "../contracts/screen-preferences";
import { privacyScreenMessages, privacyTimerLabel } from "./privacy-screen-messages";

/**
 * The privacy screen's timer as the profile menu and the settings page offer it. A choice shows at once; when the
 * server does not save it, the previous value returns and a message offers to try again. The last choice decides
 * when several are on their way.
 */
export function createPrivacyTimerChoice(initial: PrivacyTimerSeconds, locale: () => string) {
  const [value, setValue] = createSignal(initial);
  const [failed, setFailed] = createSignal<PrivacyTimerSeconds | null>(null);
  const [saved, setSaved] = createSignal(false);
  let confirmed = initial;
  let latest = 0;
  const t = () => privacyScreenMessages.resolve([locale()]).t;
  onMount(() =>
    onCleanup(
      onPrivacyTimer((seconds) => {
        confirmed = seconds;
        setValue(seconds);
      }),
    ),
  );
  const choose = async (next: PrivacyTimerSeconds, options: { toast?: boolean } = { toast: true }) => {
    const ticket = ++latest;
    setValue(next);
    setFailed(null);
    setSaved(false);
    const ok = await savePrivacyTimer(next);
    if (ticket !== latest) return;
    if (ok) {
      setSaved(true);
      return;
    }
    setValue(confirmed);
    setFailed(next);
    if (options.toast) {
      toast.error(t().timerNotSaved({ value: privacyTimerLabel(t(), confirmed) }), {
        action: { label: t().retry, onClick: () => void choose(next) },
      });
    }
  };
  const options = () => PRIVACY_TIMER_CHOICES.map((seconds) => ({ value: String(seconds), label: privacyTimerLabel(t(), seconds) }));
  return { value, choose, failed, saved, options, messages: t };
}

export const parsePrivacyTimer = (value: string): PrivacyTimerSeconds | undefined =>
  PRIVACY_TIMER_CHOICES.find((seconds) => String(seconds) === value);

export { requestPrivacyScreen } from "../browser/privacy-timer";
export { PRIVACY_SHORTCUT } from "./privacy-screen-constants";
