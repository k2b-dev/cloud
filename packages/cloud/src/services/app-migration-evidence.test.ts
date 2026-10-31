import { expect, test } from "bun:test";
import { evaluateLegacyObservation } from "./app-migration-evidence";

const start = new Date("2030-01-01T00:00:00.000Z");
const end = new Date("2030-01-02T00:00:00.000Z");
test("no start, no chosen window or an unfinished window never proves retirement safe", () => {
  expect(evaluateLegacyObservation(null, null, end, 86400).complete).toBe(false);
  expect(evaluateLegacyObservation(start, null, end).complete).toBe(false);
  expect(evaluateLegacyObservation(start, null, end, 86401).complete).toBe(false);
  expect(evaluateLegacyObservation(start, null, end, 86400).complete).toBe(true);
});
test("legacy use on either path restarts the clean window; historical use before the explicit start does not", () => {
  expect(evaluateLegacyObservation(start, new Date("2030-01-01T23:00:00.000Z"), end, 86400).complete).toBe(false);
  expect(evaluateLegacyObservation(start, new Date("2029-12-31T23:00:00.000Z"), end, 86400).complete).toBe(true);
});
