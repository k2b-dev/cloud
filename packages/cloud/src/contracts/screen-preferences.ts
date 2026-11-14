import { z } from "zod";
import { DEFAULT_PRIVACY_TIMER_SECONDS, type PrivacyTimerSeconds } from "./privacy-timer";

export { DEFAULT_PRIVACY_TIMER_SECONDS, PRIVACY_TIMER_CHOICES, type PrivacyTimerSeconds } from "./privacy-timer";

/** The privacy screen's timer in seconds, for the API and the service; browser code uses `./privacy-timer`. */
export const PrivacyTimerSecondsSchema = z.union([z.literal(0), z.literal(30), z.literal(60), z.literal(120), z.literal(300)]);
// The schema and the plain choices name the same values; a choice added on one side fails to compile.
const sameChoices: [z.infer<typeof PrivacyTimerSecondsSchema>, PrivacyTimerSeconds] extends [
  PrivacyTimerSeconds,
  z.infer<typeof PrivacyTimerSecondsSchema>,
]
  ? true
  : never = true;
void sameChoices;

/** A person's preferences for their screen, the same on every computer they sign in on. */
export const ScreenPreferencesSchema = z.object({ privacyTimerSeconds: PrivacyTimerSecondsSchema }).strict();
export type ScreenPreferences = z.infer<typeof ScreenPreferencesSchema>;
export const defaultScreenPreferences = (): ScreenPreferences => ({ privacyTimerSeconds: DEFAULT_PRIVACY_TIMER_SECONDS });
