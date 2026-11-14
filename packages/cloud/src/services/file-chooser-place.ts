import type { SQL } from "bun";
import { type FileChooserPlace, FileChooserPlaceSchema } from "../contracts/file-chooser-place";
import { sql } from "../runtime/clients";

type PlaceRow = { appId: string; folders: unknown };

/** Core-owned data: the last place of each person in the file chooser, shared by every app and device. */
export const createFileChooserPlaceService = (injectedDb?: SQL) => {
  const db = () => injectedDb ?? sql;
  return {
    /** The remembered place, or `null` for This device and for a row this release cannot read. */
    async get(userId: string): Promise<FileChooserPlace | null> {
      const [row] = await db()<PlaceRow[]>`
      SELECT app_id AS "appId", folders FROM auth.file_chooser_places WHERE user_id = ${userId}::uuid
    `;
      if (!row) return null;
      const parsed = FileChooserPlaceSchema.safeParse(row);
      return parsed.success ? parsed.data : null;
    },
    /** The last write wins: a place is a convenience, and two open choosers simply remember the one closed last. */
    async set(userId: string, place: FileChooserPlace | null): Promise<void> {
      if (!place) {
        await db()`DELETE FROM auth.file_chooser_places WHERE user_id = ${userId}::uuid`;
        return;
      }
      const value = FileChooserPlaceSchema.parse(place);
      await db()`
      INSERT INTO auth.file_chooser_places (user_id, app_id, folders)
      VALUES (${userId}::uuid, ${value.appId}, (${JSON.stringify(value.folders)}::text)::jsonb)
      ON CONFLICT (user_id) DO UPDATE SET app_id = EXCLUDED.app_id, folders = EXCLUDED.folders, updated_at = now()
    `;
    },
  };
};
export const fileChooserPlaces = createFileChooserPlaceService();
