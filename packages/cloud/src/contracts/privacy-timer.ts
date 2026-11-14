/**
 * The privacy screen's timer choices as plain values, without a schema library: the shell, its islands and the
 * settings page load this on the first page, which must stay free of Zod (it needs `eval` and breaks the page's
 * content security policy). `screen-preferences.ts` derives the server's schema from these values.
 */
export const PRIVACY_TIMER_CHOICES = [0, 30, 60, 120, 300] as const;
/** The timer in seconds: off (0), 30 s, 1, 2 or 5 minutes. */
export type PrivacyTimerSeconds = (typeof PRIVACY_TIMER_CHOICES)[number];
/** Without a saved choice the privacy screen covers content after two idle minutes. */
export const DEFAULT_PRIVACY_TIMER_SECONDS: PrivacyTimerSeconds = 120;

export const isPrivacyTimerSeconds = (value: unknown): value is PrivacyTimerSeconds =>
  PRIVACY_TIMER_CHOICES.some((choice) => choice === value);
