import { expect, test } from "bun:test";
import { runFilesMaintenance } from "./lifecycle";

const input = { signal: new AbortController().signal, heartbeat: async () => {} };
const maintenance = { processed: 2, archived: 1, pending: 0, activityChecked: 2, activityPurged: 0 };
const homes = { processed: 1, done: 1, pending: 0, failed: 0, nextCursor: null };
test("maintenance still reconciles homes after a failure and preserves the first error", async () => {
  const original = new Error("maintenance failed");
  let reconciled = false;
  await expect(
    runFilesMaintenance(input, {
      maintain: async () => {
        throw original;
      },
      reconcileUserHomes: async () => {
        reconciled = true;
        throw new Error("reconcile failed");
      },
    }),
  ).rejects.toBe(original);
  expect(reconciled).toBe(true);
});
test("successful maintenance exposes reconciliation failures and combines successful results", async () => {
  const failure = new Error("reconcile failed");
  await expect(
    runFilesMaintenance(input, {
      maintain: async () => maintenance,
      reconcileUserHomes: async () => {
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
  expect(await runFilesMaintenance(input, { maintain: async () => maintenance, reconcileUserHomes: async () => homes })).toEqual({
    ...maintenance,
    homes,
  });
});
