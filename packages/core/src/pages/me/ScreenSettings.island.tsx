import type { PrivacyTimerSeconds } from "@k2b/cloud/contracts/screen-preferences";
import { createPrivacyTimerChoice, PRIVACY_SHORTCUT, parsePrivacyTimer, requestPrivacyScreen } from "@k2b/cloud/ssr/privacy-timer-choice";
import type { KeyboardPlatform } from "@k2b/ui";
import { Button, Kbd, SegmentedControl, SettingsGroup, SettingsSection, useLocale } from "@k2b/ui";
import { Match, Switch } from "solid-js";
import { accountMessages } from "./messages";

/**
 * Profile settings › At your screen: the privacy screen's timer for the person, the same choice the profile menu
 * offers. A choice applies at once; a failed save returns to the previous value and says so where the choice was made.
 */
export default function ScreenSettings(props: { timerSeconds: PrivacyTimerSeconds; platform?: KeyboardPlatform }) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const privacy = createPrivacyTimerChoice(props.timerSeconds, locale);
  const retry = () => {
    const next = privacy.failed();
    if (next !== null) void privacy.choose(next, { toast: false });
  };
  return (
    <div id="screen" class="scroll-mt-4">
      <SettingsSection title={t().screenTitle} subtitle={t().screenDescription} icon="ti ti-device-desktop">
        <SettingsGroup
          title={privacy.messages().title}
          description={
            <>
              <span class="flex items-center gap-1.5 text-xs">
                <i class="ti ti-user" aria-hidden="true" />
                {t().privacyScope}
              </span>
              <span class="mt-2 block">{t().privacyDescription}</span>
            </>
          }
        >
          <div class="flex flex-col gap-5">
            <div class="flex flex-col gap-2">
              <div>
                <p class="text-sm font-medium text-primary">{privacy.messages().timer}</p>
                <p class="text-xs text-dimmed">{t().privacyTimerHint}</p>
              </div>
              <SegmentedControl
                class="sm:max-w-sm"
                options={privacy.options()}
                value={() => String(privacy.value())}
                ariaLabel={privacy.messages().timer}
                onValueChange={(value) => {
                  const seconds = parsePrivacyTimer(value);
                  if (seconds !== undefined) void privacy.choose(seconds, { toast: false });
                }}
              />
              {/* One line of its own, kept while empty, so a status never moves the fields below. */}
              <p class="flex min-h-5 items-center gap-1.5 text-xs" role="status">
                <Switch>
                  {/* Off is 0: test the failure for null, not for truth. */}
                  <Match when={privacy.failed() !== null}>
                    <span class="flex items-center gap-1.5 text-[var(--k2b-danger-text)]">
                      <i class="ti ti-alert-circle" aria-hidden="true" />
                      {t().privacyNotSaved} ·
                      <Button variant="ghost" size="sm" onClick={retry}>
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
            <div class="cloud-privacy-try flex flex-wrap items-center justify-between gap-3">
              <div>
                <p class="text-sm font-medium text-primary">{t().privacyNowTitle}</p>
                <p class="flex flex-wrap items-center gap-1 text-xs text-dimmed">
                  {t().privacyNowHint}
                  <Kbd keys={PRIVACY_SHORTCUT} platform={props.platform} />
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={requestPrivacyScreen}>
                {t().privacyTry}
              </Button>
            </div>
          </div>
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
