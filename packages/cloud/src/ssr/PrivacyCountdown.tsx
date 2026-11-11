import { useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { onPrivacyTimer } from "../browser/privacy-timer";
import { privacyScreenMessages } from "./privacy-screen-messages";

/**
 * The privacy screen's countdown in the app bar, directly above the profile. Its place exists only while the timer is
 * on, from the server's first frame, so it never pushes the profile when it appears. The runtime shows it during the
 * last ten seconds and empties its ring; it is decoration, out of the tab order and hidden from screen readers.
 */
export default function PrivacyCountdown(props: { timerSeconds: number }) {
  const locale = useLocale();
  const [timer, setTimer] = createSignal(props.timerSeconds);
  onMount(() => onCleanup(onPrivacyTimer(setTimer)));
  return (
    <Show when={timer() > 0}>
      <div class="cloud-privacy-countdown" aria-hidden="true">
        <span class="cloud-privacy-countdown__icon">
          <svg class="cloud-privacy-countdown__ring" viewBox="0 0 40 40" aria-hidden="true">
            <circle class="cloud-privacy-countdown__track" cx="20" cy="20" r="18" />
            <circle class="cloud-privacy-countdown__arc" cx="20" cy="20" r="18" pathLength="1" />
          </svg>
          <i class="ti ti-eye-off" />
          <b class="cloud-privacy-countdown__seconds" data-cloud-privacy-seconds="">
            10
          </b>
        </span>
        <span class="cloud-privacy-countdown__label">{privacyScreenMessages.resolve([locale()]).t.soon}</span>
      </div>
    </Show>
  );
}
