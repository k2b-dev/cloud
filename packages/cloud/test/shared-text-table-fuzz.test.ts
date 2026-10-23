import { expect, test } from "bun:test";
import { type Gate1Result, inspectTable, runGate1Case } from "./shared-text-table-fuzz";

function assertGate(result: Gate1Result) {
  // Recovery is real ordered repair, not an expected-failure wrapper. Every
  // damaged intermediate state must have a production check and send refusal.
  if (result.errors.length)
    throw new Error(
      JSON.stringify({
        seed: result.seed,
        profile: result.profile,
        errors: result.errors,
        witnesses: result.witnesses,
        coverage: result.coverage,
        reproduce: result.reproduce,
      }),
    );
}

// Five default schedules only. Long sweeps are explicit CLI invocations under
// scripts/heavy.ts; no new env, manifest script or workflow is required.
test("Gate 1: seed 208 append → peer typing → undo recovers through ordered repair and receipt undo/redo", async () => {
  const result = await runGate1Case(208, "append-undo");
  // Keep intermediate damage in the evidence. Acceptance requires its actual
  // guard and zero settled damage; it does not require damage to occur.
  expect(result.coverage.receipts).toBeGreaterThan(0);
  expect(result.coverage.undo).toBeGreaterThan(0);
  expect(result.coverage.redo).toBeGreaterThan(0);
  expect(result.coverage.settledBroken).toBe(0);
  expect(result.coverage.settledEmailMissing).toBe(0);
  assertGate(result);
});

test("Gate 1: seed 28 column insertion, peer alignment and own Undo recover without stranded syntax", async () => {
  const result = await runGate1Case(28, "realistic");
  assertGate(result);
  expect(result.coverage.settledBroken).toBe(0);
});

test("Gate 1: fixed anchors reject deleted/replaced targets; causal receipts preserve own history", async () => {
  const result = await runGate1Case(1, "anchors");
  assertGate(result);
  expect(result.coverage.staleAccepted).toBe(1);
  expect(result.coverage.rejectedDeleted).toBe(2);
  expect(result.coverage.rejectedReplaced).toBe(1);
  expect(result.coverage.receiptDeferred).toBeGreaterThan(0);
  expect(result.coverage.intentionalDeletes).toBeGreaterThan(0);
  expect(result.coverage.convergenceChecks).toBeGreaterThan(0);
});

for (const profile of ["realistic", "adversarial"] as const) {
  test(`Gate 1: ${profile}, one seeded three-replica unit schedule`, async () => {
    const result = await runGate1Case(1, profile);
    assertGate(result);
    expect(result.coverage.offlineEdits).toBeGreaterThan(0);
    expect(result.coverage.offlineStructureBlocked).toBeGreaterThan(0);
    expect(result.coverage.reordered).toBeGreaterThan(0);
    expect(result.coverage.pending).toBeGreaterThan(0);
    expect(result.coverage.duplicates).toBe(result.coverage.deliveries);
    expect(result.coverage.serverAccepted).toBeGreaterThan(0);
  });
}

test("Gate 1 oracle includes extra visible cells even when email drops them", () => {
  const extra = "\ue123";
  const state = inspectTable(`| A | B |\n| --- | --- |\n| one | two | ${extra} |`);
  expect(state.broken).toBe(true);
  expect(state.extras).toBe(1);
  expect(state.visible).toContain(extra);
  expect(state.emailMissing).toEqual([extra]);
});

// Withheld empty-column insertion and a different column's Undo can cancel
// in local text bytes; the authoritative inverse must still remove its target.
test("Gate 1: adversarial9 compares structural no-op against canonical state", async () => {
  assertGate(await runGate1Case(9, "adversarial"));
});
