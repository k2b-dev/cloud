import type { PrivacyTimerSeconds } from "@k2b/cloud/contracts/privacy-timer";
import { createPrivacyTimerChoice, PRIVACY_SHORTCUT, parsePrivacyTimer, requestPrivacyScreen } from "@k2b/cloud/ssr/privacy-timer-choice";
import { createSharedWorkstationSwitch } from "@k2b/cloud/ssr/profile-actions";
import { formatShortcut, type KeyboardPlatform, useLocale } from "@k2b/ui";
import { Check, Row, Section, Select, Text, useToast } from "@k2b/ui/v2";
import { createEffect, on, Show } from "solid-js";
import { useAccountMessages } from "./AccountWorkspace";

/**
 * Profile › At your screen: the privacy screen's timer for the person and the shared workstation mark for this browser.
 * A timer choice applies at once; the field's hint line says whether it was saved (it never moves what follows), and a
 * failed save returns to the previous value and offers "Try again" in a toast.
 */
export default function ScreenSection(props: {
  timerSeconds: PrivacyTimerSeconds;
  platform?: KeyboardPlatform;
  /** Browser sessions only: the person and the administrator's idle minutes for a shared workstation. */
  sharedWorkstation?: { userId: string; minutes: number };
}) {
  const t = useAccountMessages();
  const locale = useLocale();
  const toast = useToast();
  const privacy = createPrivacyTimerChoice(props.timerSeconds, locale);
  const shared = createSharedWorkstationSwitch(props.sharedWorkstation?.userId, locale);
  // Off is 0: test the failure for null, not for truth.
  createEffect(
    on(privacy.failed, (failed) => {
      if (failed !== null) toast(t().privacyNotSaved, { status: "bad", retry: privacy.retry });
    }),
  );
  const shortcut = () => formatShortcut(PRIVACY_SHORTCUT, { platform: props.platform, locale: locale() }).label;
  // k2b-ui gap: Section has no anchor id; PRIVACY_SETTINGS_HREF ("/me#screen") lands at the top of the profile.
  // k2b-ui gap: `Setting` (#4223, not on main yet) puts name and hint left and the value beside them; until then a
  // `Row` holds the control at its end. A switch stays a labelled `Check`: `Check` cannot take its name from a row.
  return (
    <Section icon="device-desktop" title={t().screenTitle}>
      <Row
        lines={[
          privacy.messages().timer,
          privacy.failed() !== null ? t().privacyNotSaved : privacy.saved() ? t().privacySaved : t().privacyTimerHint,
        ]}
        end={
          <Select
            label={privacy.messages().timer}
            options={privacy.options()}
            value={String(privacy.value())}
            onChange={(value) => {
              const seconds = parsePrivacyTimer(value);
              if (seconds !== undefined) privacy.choose(seconds);
            }}
          />
        }
      />
      <Show when={props.sharedWorkstation}>
        {(workstation) => (
          // The switch carries the setting's name itself (its label wraps it), so assistive technology names it; the
          // hint follows as quiet text.
          <>
            <Check
              switch
              label={shared.messages().label}
              checked={shared.shared()}
              disabled={shared.pending()}
              onChange={() => void shared.toggle()}
            />
            <Text muted type="meta">
              {t().sharedWorkstationHint({ minutes: workstation().minutes })}
            </Text>
          </>
        )}
      </Show>
      <Row lines={[t().privacyNowTitle, shortcut()]} action={{ label: t().privacyTry, onClick: requestPrivacyScreen }} />
    </Section>
  );
}
