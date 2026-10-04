import { expect, test } from "bun:test";
import { captureContactLiveCursor } from "./live";

test("captureContactLiveCursor yields null instead of sequence 0 when the live transport is unavailable", async () => {
  // No process sync is bound: SSR must still render, and the island subscribes without a cursor.
  expect(await captureContactLiveCursor()).toBeNull();
});
