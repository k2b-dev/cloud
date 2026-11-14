import { expect, test } from "bun:test";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { sql } from "../../runtime/clients";
import { resolveResourceReaders } from "./resource-readers";

const suite = databaseSuite();

suite("resource readers and account locks", () => {
  test("a locked account and its delegated service account are not readers until the account is unlocked", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`reader-lock-${suffix}`}, 'ipa', 'user', 'Reader Lock', ${`reader-lock-${suffix}@example.test`}, 'Reader', 'Lock')
      RETURNING id
    `;
    const userId = user!.id;
    const [delegated] = await sql<{ id: string }[]>`
      INSERT INTO auth.service_accounts (name, kind, delegated_user_id) VALUES ('Delegated reader', 'user_delegated', ${userId}::uuid)
      RETURNING id
    `;
    const principals = [
      { type: "user" as const, userId },
      { type: "service_account" as const, serviceAccountId: delegated!.id },
    ];
    const readers = async () => (await resolveResourceReaders(principals)).map((reader) => reader.principal);
    try {
      expect(await readers()).toEqual(principals);

      await sql`INSERT INTO auth.user_ipa_data (user_id, locked_at) VALUES (${userId}::uuid, now())`;
      expect(await readers()).toEqual([]);

      await sql`UPDATE auth.user_ipa_data SET locked_at = NULL WHERE user_id = ${userId}::uuid`;
      expect(await readers()).toEqual(principals);
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});
