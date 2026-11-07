// A real second OS process: commit on its own SQL connection, then publish on its own NATS connection.
import assert from "node:assert/strict";
import { SQL } from "bun";
import { readTestTarget } from "../../../../scripts/fixtures/test-infra-env";
import { connectTestNats } from "../../../../scripts/fixtures/test-nats";
import { pgOutboxKey, workWakeSubject } from "../../src/_internal/work-wake";

const target = readTestTarget(process.env, "database");
assert(target && new URL(target).pathname.endsWith("_test"));
const [table, namespace, itemId] = process.argv.slice(2);
assert(table && /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(table));
assert(namespace && itemId);
const database = new SQL(target);
const connection = await connectTestNats({ ignoreClusterUpdates: true });
try {
  await database.begin(async (tx) => {
    await tx`INSERT INTO ${database.unsafe(table)} (item_id, delta) VALUES (${itemId}::uuid, 99)`;
  });
  connection.publish(workWakeSubject(namespace, pgOutboxKey(table)));
  await connection.flush();
} finally {
  await database.close();
  await connection.drain();
}
