import type { PrivacyTimerSeconds } from "@k2b/cloud/contracts/privacy-timer";
import { createPrivacyTimerChoice, PRIVACY_SHORTCUT, parsePrivacyTimer, requestPrivacyScreen } from "@k2b/cloud/ssr/privacy-timer-choice";
import { createSharedWorkstationSwitch } from "@k2b/cloud/ssr/profile-actions";
import type { KeyboardPlatform } from "@k2b/ui";
import { Button, Kbd, SegmentedControl, SettingsSection, Switch as SwitchField, useLocale } from "@k2b/ui";
import { type JSX, Match, Show, Switch } from "solid-js";
import { accountMessages } from "./messages";

/** One setting per row: a one-line label above its control, the same at every width. */
function Row(props: { label: string; children: JSX.Element; class?: string }) {
  return (
    <div class={`flex flex-col gap-2 ${props.class ?? ""}`}>
      <p class="min-w-0 truncate text-sm font-medium text-primary">{props.label}</p>
      <div class="flex min-w-0 flex-wrap items-center gap-2">{props.children}</div>
    </div>
  );
}

/**
 * Profile settings › At your screen: the privacy screen for the person and the shared workstation mark for this
 * browser. Short and quiet; Help explains the rest. A timer choice applies at once; a failed save returns to the
 * previous value and offers to try again in place.
 */
export default function ScreenSettings(props: {
  timerSeconds: PrivacyTimerSeconds;
  platform?: KeyboardPlatform;
  /** Browser sessions only: the person and the administrator's idle minutes for a shared workstation. */
  sharedWorkstation?: { userId: string; minutes: number };
}) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const privacy = createPrivacyTimerChoice(props.timerSeconds, locale);
  const shared = createSharedWorkstationSwitch(props.sharedWorkstation?.userId, locale);
  return (
    <div id="screen" class="scroll-mt-4">
      <SettingsSection title={t().screenTitle} subtitle={t().screenDescription} icon="ti ti-device-desktop">
        <div class="flex flex-col gap-5">
          <div class="flex flex-col gap-1">
            <Row label={privacy.messages().timer}>
              <SegmentedControl
                class="max-w-sm"
                options={privacy.options()}
                value={() => String(privacy.value())}
                ariaLabel={privacy.messages().timer}
                onValueChange={(value) => {
                  const seconds = parsePrivacyTimer(value);
                  if (seconds !== undefined) privacy.choose(seconds);
                }}
              />
            </Row>
            {/* One line of its own, kept while empty, so a status never moves the rows below. */}
            <p class="flex min-h-5 items-center gap-1.5 text-xs" role="status">
              <Switch>
                {/* Off is 0: test the failure for null, not for truth. */}
                <Match when={privacy.failed() !== null}>
                  <span class="flex items-center gap-1.5 text-[var(--k2b-danger-text)]">
                    <i class="ti ti-alert-circle" aria-hidden="true" />
                    {t().privacyNotSaved} ·
                    <Button variant="ghost" size="sm" onClick={privacy.retry}>
                      {privacy.messages().retry}
                    </Button>
                  </span>
                </Match>
                <Match when={privacy.saved()}>
                  <span class="flex items-center gap-1.5 text-dimmed">
                    <i class="ti ti-check" aria-hidden="true" />
                    {t().privacySaved}
                  </span>
                </Match>
              </Switch>
            </p>
          </div>
          <Row label={t().privacyNowTitle} class="cloud-privacy-try">
            <Kbd keys={PRIVACY_SHORTCUT} platform={props.platform} />
            <Button variant="secondary" size="sm" onClick={requestPrivacyScreen}>
              {t().privacyTry}
            </Button>
          </Row>
          <Show when={props.sharedWorkstation}>
            {(workstation) => (
              <SwitchField
                label={shared.messages().label}
                description={t().sharedWorkstationHint({ minutes: workstation().minutes })}
                value={shared.shared}
                disabled={shared.pending()}
                onValueChange={() => void shared.toggle()}
              />
            )}
          </Show>
        </div>
      </SettingsSection>
    </div>
  );
}
