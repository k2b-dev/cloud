import { afterAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { meterSql } from "../../../../../../scripts/fixtures/sql-meter";
import { databaseSuite } from "../../../../../../scripts/fixtures/test-infra";
import { keyCreatorNames } from "./key-creators";

const created: string[] = [];
const person = async (uid: string, displayName: string) => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name) VALUES (${uid}, 'local', 'user', ${displayName}) RETURNING id`;
  created.push(row!.id);
  return row!.id;
};

databaseSuite()("the names of an app's key creators (integration)", () => {
  afterAll(async () => {
    for (const id of created) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  test("every creator of a key list is named in one statement, however many keys and creators it has", async () => {
    const suffix = crypto.randomUUID();
    const mara = await person(`mara-${suffix}`, "Mara Lindqvist");
    const jo = await person(`jo-${suffix}`, "");
    const third = await person(`aleksandra-${suffix}`, "Aleksandra Wiśniewska-Kowalczyk");
    const gone = crypto.randomUUID();
    // twelve keys by four creators, one of whom no longer has an account, and two keys without a creator
    const keys = [mara, jo, third, gone, mara, jo, third, gone, mara, jo, null, null].map((createdBy) => ({ createdBy }));
    const meter = await meterSql();
    try {
      let names: Record<string, string> = {};
      const statements = await meter.during(async () => {
        names = await keyCreatorNames(keys);
      });
      expect(statements).toHaveLength(1);
      // a person without a display name is named by their user name; one whose account is gone is not named
      expect(names).toEqual({ [mara]: "Mara Lindqvist", [jo]: `jo-${suffix}`, [third]: "Aleksandra Wiśniewska-Kowalczyk" });
      expect(await meter.during(() => keyCreatorNames([{ createdBy: null }]))).toHaveLength(0);
    } finally {
      await meter.close();
    }
  });
});
