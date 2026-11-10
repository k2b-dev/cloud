import { createSignal, onCleanup, onMount } from "solid-js";
import { announceSavedPrivacyTimer, onPrivacyTimer, savePrivacyTimer } from "../browser/privacy-timer";
import { PRIVACY_TIMER_CHOICES, type PrivacyTimerSeconds } from "../contracts/screen-preferences";
import { privacyScreenMessages, privacyTimerLabel } from "./privacy-screen-messages";

/**
 * The privacy screen's timer as Profile settings › At your screen offers it. A choice shows at once; when the server
 * does not save it, the previous value returns and the page offers to try again. Saves run one after another and only
 * the last choice is sent once the running save ends, so the server and every tab end at the last choice.
 */
export function createPrivacyTimerChoice(initial: PrivacyTimerSeconds, locale: () => string) {
  const [value, setValue] = createSignal(initial);
  const [failed, setFailed] = createSignal<PrivacyTimerSeconds | null>(null);
  const [saved, setSaved] = createSignal(false);
  let confirmed = initial;
  /** The value the runtime and the other tabs last heard. */
  let announced = initial;
  let pending: PrivacyTimerSeconds | null = null;
  let saving = false;
  const t = () => privacyScreenMessages.resolve([locale()]).t;
  onMount(() =>
    onCleanup(
      onPrivacyTimer((seconds) => {
        confirmed = seconds;
        announced = seconds;
        if (!saving && pending === null) setValue(seconds);
      }),
    ),
  );
  const announce = (seconds: PrivacyTimerSeconds) => {
    announced = seconds;
    announceSavedPrivacyTimer(seconds);
  };
  const flush = async () => {
    saving = true;
    while (pending !== null) {
      const seconds: PrivacyTimerSeconds = pending;
      pending = null;
      const ok = await savePrivacyTimer(seconds);
      if (ok) confirmed = seconds;
      // A newer choice waits; it decides what the page shows and what the other tabs hear.
      if (pending !== null) continue;
      saving = false;
      if (ok) {
        announce(seconds);
        setSaved(true);
        return;
      }
      // An earlier choice may have saved meanwhile; the runtime and the other tabs follow the saved value.
      if (confirmed !== announced) announce(confirmed);
      setValue(confirmed);
      setFailed(seconds);
      return;
    }
    saving = false;
  };
  const choose = (next: PrivacyTimerSeconds) => {
    setValue(next);
    setFailed(null);
    setSaved(false);
    pending = next;
    if (!saving) void flush();
  };
  /** Tries the failed choice again. */
  const retry = () => {
    const next = failed();
    if (next !== null) choose(next);
  };
  const options = () => PRIVACY_TIMER_CHOICES.map((seconds) => ({ value: String(seconds), label: privacyTimerLabel(t(), seconds) }));
  return { value, choose, retry, failed, saved, options, messages: t };
}

export const parsePrivacyTimer = (value: string): PrivacyTimerSeconds | undefined =>
  PRIVACY_TIMER_CHOICES.find((seconds) => String(seconds) === value);

export { requestPrivacyScreen } from "../browser/privacy-timer";
export { PRIVACY_SHORTCUT } from "./privacy-screen-constants";
