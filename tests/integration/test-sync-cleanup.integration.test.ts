/**
 * Proves the JetStream cleanup behind every integration test process: a test
 * namespace is deleted with the namespaces derived from it, and nothing else.
 */
import { expect } from "bun:test";
import { connectTestNats, testFor, testSyncNamespace } from "../../scripts/fixtures/test-infra";
import { deleteTestNamespace } from "../../scripts/fixtures/test-sync";

testFor("nats")("deleting a test namespace removes its derived namespaces and keeps its siblings", async () => {
  const connection = await connectTestNats({ ignoreClusterUpdates: true });
  // Every namespace here derives from the process namespace, so the fixture removes the
  // sibling afterwards, and all of them when an assertion fails.
  const namespace = testSyncNamespace("cleanup");
  const stream = (streamNamespace: string) => ({
    namespace: streamNamespace,
    name: `TEST_CLEANUP_${crypto.randomUUID().replaceAll("-", "")}`,
  });
  const own = stream(namespace);
  const derived = stream(`${namespace}-derived`);
  const sibling = stream(`${namespace}0`);
  const exists = async (name: string) => !(await connection.request(`$JS.API.STREAM.INFO.${name}`)).json<{ error?: unknown }>().error;
  try {
    for (const { namespace: streamNamespace, name } of [own, derived, sibling]) {
      const created = await connection.request(
        `$JS.API.STREAM.CREATE.${name}`,
        JSON.stringify({
          name,
          subjects: [`test.cleanup.${name}`],
          storage: "memory",
          max_bytes: 1024,
          num_replicas: 1,
          metadata: { "sync.namespace": streamNamespace },
        }),
      );
      expect(created.json<{ error?: unknown }>().error).toBeUndefined();
    }

    expect(await deleteTestNamespace(namespace)).toBe(2);

    expect(await exists(own.name)).toBe(false);
    expect(await exists(derived.name)).toBe(false);
    expect(await exists(sibling.name)).toBe(true);
  } finally {
    await connection.close();
  }
});
