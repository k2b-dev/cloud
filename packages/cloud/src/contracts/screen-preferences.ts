import { z } from "zod";

/** The privacy screen's timer in seconds: off (0), 30 s, 1, 2 or 5 minutes. */
export const PrivacyTimerSecondsSchema = z.union([z.literal(0), z.literal(30), z.literal(60), z.literal(120), z.literal(300)]);
export type PrivacyTimerSeconds = z.infer<typeof PrivacyTimerSecondsSchema>;
export const PRIVACY_TIMER_CHOICES: readonly PrivacyTimerSeconds[] = [0, 30, 60, 120, 300];
/** Without a saved choice the privacy screen covers content after two idle minutes. */
export const DEFAULT_PRIVACY_TIMER_SECONDS: PrivacyTimerSeconds = 120;

/** A person's preferences for their screen, the same on every computer they sign in on. */
export const ScreenPreferencesSchema = z.object({ privacyTimerSeconds: PrivacyTimerSecondsSchema }).strict();
export type ScreenPreferences = z.infer<typeof ScreenPreferencesSchema>;
export const defaultScreenPreferences = (): ScreenPreferences => ({ privacyTimerSeconds: DEFAULT_PRIVACY_TIMER_SECONDS });
