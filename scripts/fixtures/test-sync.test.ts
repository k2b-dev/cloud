import { describe, expect, test } from "bun:test";
import { deleteTestNamespace, type StreamInfo, staleAfterMs, staleTestNamespaces } from "./test-sync";

const now = Date.parse("2026-09-27T12:00:00Z");
const old = new Date(now - staleAfterMs - 1).toISOString();
const recent = new Date(now - staleAfterMs + 60_000).toISOString();

const stream = (name: string, namespace: string | undefined, created: string): StreamInfo => ({
  config: { name, ...(namespace ? { metadata: { "sync.namespace": namespace } } : {}) },
  created,
});

describe("staleTestNamespaces", () => {
  test("selects only test namespaces whose every stream is old", () => {
    const stale = staleTestNamespaces(
      [
        stream("A1", "test-0a1b2c3d", old),
        stream("A2", "test-0a1b2c3d", old),
        stream("B1", "test-0a1b2c3d-spaces-events-12345678", old),
        stream("C1", "test-mail-live", old),
        stream("C2", "test-mail-live", recent),
        stream("D1", "dev", old),
        stream("E1", "prod-test-1", old),
        stream("F1", undefined, old),
      ],
      now,
    );
    expect([...stale]).toEqual([
      ["test-0a1b2c3d", ["A1", "A2"]],
      ["test-0a1b2c3d-spaces-events-12345678", ["B1"]],
    ]);
  });

  test("keeps a stream whose creation time cannot be read", () => {
    expect(staleTestNamespaces([stream("A1", "test-0a1b2c3d", "")], now).size).toBe(0);
  });
});

test("deleteTestNamespace refuses a namespace outside the test prefix", async () => {
  await expect(deleteTestNamespace([], "dev")).rejects.toThrow('Refusing to delete Sync namespace "dev"');
});
