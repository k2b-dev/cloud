import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { migrate } from "./pwa";

databaseSuite()("Cloud app startup migration", () => {
  test("restarting keeps self-pairing and administrative device confirmation states", async () => {
    await migrate();
    const userId = crypto.randomUUID();
    const adminId = crypto.randomUUID();
    await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name)
      VALUES (${userId}::uuid, ${`migration-owner-${userId}`}, 'local', 'user', 'Owner'),
      (${adminId}::uuid, ${`migration-admin-${adminId}`}, 'local', 'user', 'Admin')`;
    try {
      for (const state of ["pending", "claimed", "confirmed", "completed", "cancelled", "awaiting_device", "rejected"]) {
        const admin = state === "awaiting_device" || state === "rejected" ? adminId : null;
        await sql`INSERT INTO auth.pwa_pairings (id, user_id, initiator_sid, initiator_user_id, auth_epoch, link_secret_hash, state, claim_until, expires_at)
          VALUES (${crypto.randomUUID()}::uuid, ${userId}::uuid, ${crypto.randomUUID()}::uuid, ${admin}::uuid, 0, ${`hash-${state}-${userId}`}, ${state}, now() + interval '5 minutes', now() + interval '10 minutes')`;
      }
      await migrate();
      const rows = await sql<
        { state: string; initiator_user_id: string | null }[]
      >`SELECT state, initiator_user_id FROM auth.pwa_pairings WHERE user_id = ${userId}::uuid`;
      expect(rows).toHaveLength(7);
      expect(rows.find((row) => row.state === "claimed")?.initiator_user_id).toBeNull();
      expect(rows.find((row) => row.state === "awaiting_device")?.initiator_user_id).toBe(adminId);
    } finally {
      await sql`DELETE FROM auth.users WHERE id IN (${userId}::uuid, ${adminId}::uuid)`;
    }
  });

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
