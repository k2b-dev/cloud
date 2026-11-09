import { expect, test } from "bun:test";
import { generateCodeSdk } from "./generator";
import { createCodeTestBridge } from "./test-bridge";

test("database fixtures use bound inputs and direct rows without any real database", async () => {
  const bridge = createCodeTestBridge(generateCodeSdk([], { mode: "personal" }).manifest, [
    {
      operation: "db.query",
      target: null,
      input: { sql: "SELECT ? AS value", params: ["'; DROP TABLE notes; --"] },
      replies: [{ ok: true, data: [{ value: "bound" }] }],
    },
  ]);
  expect(await bridge.call("db.query", { sql: "SELECT ? AS value", params: ["'; DROP TABLE notes; --"] })).toEqual([{ value: "bound" }]);
  expect(bridge.calls()[0]?.call.input).toEqual({ sql: "SELECT ? AS value", params: ["'; DROP TABLE notes; --"] });
});

test("database fixtures reject a namespace supplied by Code and reject temporary Code", async () => {
  const bridge = createCodeTestBridge(generateCodeSdk([], { mode: "personal" }).manifest, []);
  await expect(bridge.call("db.query", { sql: "SELECT 1", params: [], namespace: "code_c_other" })).rejects.toThrow();
  const temporary = createCodeTestBridge(generateCodeSdk([], { mode: "code_run" }).manifest, []);
  await expect(temporary.call("db.exec", { sql: "DELETE FROM notes", params: [] })).rejects.toThrow();
});
