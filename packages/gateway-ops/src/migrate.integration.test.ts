import { expect, test } from "bun:test";
import { sql } from "bun";
import { migrate } from "./migrate";

const dbTest = process.env.APP_JSONB_MIGRATION_TEST === "1" ? test : test.skip;

dbTest("discards malformed registry snapshots without resetting valid metadata or webhook configuration", async () => {
  await migrate();
  const prefix = crypto.randomUUID();
  const webhook = crypto.randomUUID();
  await sql`INSERT INTO gateway.health_webhooks(id,name,url,send_on) VALUES (${webhook}::uuid,'preserve','https://example.test','["error"]'::jsonb)`;
  try {
    for (let index = 0; index < 8; index++) {
      await sql`INSERT INTO gateway.registered_apps(id,name,icon,description,base_url,routes,appearance,runtime,nav,capabilities,legal_links,widgets)
        VALUES (${`${prefix}-${index}`},'app','icon','description','https://example.test',
          ${index === 1 ? "[]" : []}::jsonb,${index === 2 ? "{}" : {}}::jsonb,${index === 3 ? "{}" : {}}::jsonb,
          ${index === 4 ? "{}" : {}}::jsonb,${index === 5 ? "{}" : {}}::jsonb,${index === 6 ? "[]" : []}::jsonb,${index === 7 ? "[]" : []}::jsonb)`;
    }
    await migrate();
    const first = await sql`SELECT * FROM gateway.registered_apps WHERE id LIKE ${`${prefix}%`} ORDER BY id`;
    expect(first).toHaveLength(1);
    expect(first[0].id).toBe(`${prefix}-0`);
    const configuration = await sql`SELECT * FROM gateway.health_webhooks WHERE id=${webhook}::uuid`;
    await migrate();
    expect(await sql`SELECT * FROM gateway.registered_apps WHERE id LIKE ${`${prefix}%`} ORDER BY id`).toEqual(first);
    expect(await sql`SELECT * FROM gateway.health_webhooks WHERE id=${webhook}::uuid`).toEqual(configuration);
  } finally {
    await sql`DELETE FROM gateway.registered_apps WHERE id LIKE ${`${prefix}%`}`;
    await sql`DELETE FROM gateway.health_webhooks WHERE id=${webhook}::uuid`;
  }
});
