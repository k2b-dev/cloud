import { expect } from "bun:test";
import { sql } from "bun";
import { testFor } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { webhookTesterService } from "./webhooks";

const dbTest = testFor("database");

dbTest("refuses mapped loopback without storing an outgoing log", async () => {
  await migrate();
  const owner = crypto.randomUUID();
  await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES (${owner}::uuid,${owner},'local','user')`;
  try {
    await expect(
      webhookTesterService.send(owner, {
        url: "http://[::ffff:127.0.0.1]:1/",
        method: "GET",
        headers: {},
        body: "",
      }),
    ).rejects.toMatchObject({ code: "BLOCKED_TARGET" });
    expect(await webhookTesterService.listOutgoingLogs(owner)).toEqual([]);
  } finally {
    await sql`DELETE FROM auth.users WHERE id=${owner}::uuid`;
  }
});
