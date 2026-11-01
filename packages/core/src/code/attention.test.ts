import { expect, test } from "bun:test";
import type { CodeContext } from "./access";
import { scanCodeAccess } from "./attention";
import type { Code } from "./contracts";

test("one reconciliation per Code is in flight, also after an attention answer stopped waiting for it", async () => {
  const code = { id: "c_attn1" } as Code;
  const context = {} as CodeContext;
  let release: (value: []) => void = () => {};
  let calls = 0;
  const slow = () => {
    calls++;
    return new Promise<[]>((resolve) => {
      release = resolve;
    });
  };
  const first = scanCodeAccess(code, context, slow);
  // A later page, after the cache expired, joins the scan that is still running.
  const second = scanCodeAccess(code, context, slow);
  expect(second).toBe(first);
  expect(calls).toBe(1);
  release([]);
  await first;
  // Once it settled, the next page may scan again.
  void scanCodeAccess(code, context, slow);
  expect(calls).toBe(2);
  release([]);
});
