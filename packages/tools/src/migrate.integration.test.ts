import { expect } from "bun:test";
import { sql } from "bun";
import { testFor } from "../../../scripts/fixtures/test-infra";
import { migrate } from "./migrate";

const dbTest = testFor("database");

dbTest("discards malformed webhook logs while preserving endpoints and valid logs across startup", async () => {
  await migrate();
  const owner = crypto.randomUUID();
  const endpoint = crypto.randomUUID();
  await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES (${owner}::uuid,${owner},'local','user')`;
  try {
    await sql`INSERT INTO tools.webhook_endpoints(id,owner_user_id,token,name)
      VALUES (${endpoint}::uuid,${owner}::uuid,${endpoint},'preserve endpoint')`;
    for (const [request, response] of [
      [{}, null],
      [{}, {}],
      ['{"x":"y"}', null],
      [{}, "not-json"],
      [[], null],
      [{ fresh: "header" }, null],
    ] as const) {
      await sql`INSERT INTO tools.webhook_logs(endpoint_id,owner_user_id,direction,method,url,request_headers,response_headers)
        VALUES (${endpoint}::uuid,${owner}::uuid,'incoming','POST','https://example.test',${request}::jsonb,${response}::jsonb)`;
    }
    await migrate();
    const first =
      await sql`SELECT id,request_headers,response_headers,created_at FROM tools.webhook_logs WHERE endpoint_id=${endpoint}::uuid ORDER BY id`;
    expect(first).toHaveLength(3);
    expect(await sql<{ name: string; token: string }[]>`SELECT name,token FROM tools.webhook_endpoints WHERE id=${endpoint}::uuid`).toEqual(
      [{ name: "preserve endpoint", token: endpoint }],
    );
    await migrate();
    expect(
      await sql`SELECT id,request_headers,response_headers,created_at FROM tools.webhook_logs WHERE endpoint_id=${endpoint}::uuid ORDER BY id`,
    ).toEqual(first);
  } finally {
    await sql`DELETE FROM auth.users WHERE id=${owner}::uuid`;
  }
});
