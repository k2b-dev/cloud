import type { SQL } from "bun";
import { defaultScreenPreferences, PrivacyTimerSecondsSchema, type ScreenPreferences } from "../contracts/screen-preferences";
import { sql } from "../runtime/clients";

/** Core-owned data, read by the platform SSR seam for every signed-in page. */
export const createScreenPreferencesService = (injectedDb?: SQL) => {
  const db = () => injectedDb ?? sql;
  return {
    async get(userId: string): Promise<ScreenPreferences> {
      const [row] = await db()<{ seconds: number }[]>`
        SELECT privacy_timer_seconds AS seconds FROM auth.screen_preferences WHERE user_id = ${userId}::uuid
      `;
      // A value this release does not offer, such as one a later release wrote, reads as the default.
      const seconds = PrivacyTimerSecondsSchema.safeParse(row?.seconds);
      return seconds.success ? { privacyTimerSeconds: seconds.data } : defaultScreenPreferences();
    },
    async save(userId: string, input: ScreenPreferences): Promise<ScreenPreferences> {
      await db()`
        INSERT INTO auth.screen_preferences (user_id, privacy_timer_seconds)
        VALUES (${userId}::uuid, ${input.privacyTimerSeconds})
        ON CONFLICT (user_id) DO UPDATE SET privacy_timer_seconds = EXCLUDED.privacy_timer_seconds
      `;
      return { privacyTimerSeconds: input.privacyTimerSeconds };
    },
  };
};
export const screenPreferences = createScreenPreferencesService();
