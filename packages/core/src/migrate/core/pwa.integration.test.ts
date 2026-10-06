import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { migrate } from "./pwa";

databaseSuite()("mobile app startup migration", () => {
  test("a restart leaves a phone that still waits for its notice pending", async () => {
    await migrate();
    const userId = crypto.randomUUID();
    const deviceId = crypto.randomUUID();
    await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name)
      VALUES (${userId}::uuid, ${`pwa-migrate-${userId}`}, 'local', 'user', 'Migration Test')`;
    try {
      await sql`INSERT INTO auth.pwa_devices (id, user_id, name, platform, auth_epoch, secret_hash, rotated_at)
        VALUES (${deviceId}::uuid, ${userId}::uuid, 'iPhone', 'ios', 0, 'hash', now())`;
      await migrate();
      const [device] = await sql<{ notified_at: Date | null }[]>`SELECT notified_at FROM auth.pwa_devices WHERE id = ${deviceId}::uuid`;
      expect(device?.notified_at).toBeNull();
      const [column] = await sql<{ column_default: string | null }[]>`
        SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'auth' AND table_name = 'pwa_devices' AND column_name = 'notified_at'`;
      expect(column?.column_default).toBeNull();
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});
