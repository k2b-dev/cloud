import { afterEach, expect, jest, setSystemTime, test } from "bun:test";
import { watchCredentialExpiry } from "./app-access";

afterEach(() => {
  jest.useRealTimers();
  setSystemTime();
});
test("the known credential deadline closes a socket even with no Core event", () => {
  jest.useFakeTimers();
  const now = new Date("2026-11-12T12:00:00Z");
  setSystemTime(now);
  let expired = 0;
  const stop = watchCredentialExpiry(now.getTime() + 60_000, () => {
    expired++;
  });
  jest.advanceTimersByTime(59_999);
  expect(expired).toBe(0);
  jest.advanceTimersByTime(1);
  expect(expired).toBe(1);
  stop();
});
test("disconnect cancels the deadline", () => {
  jest.useFakeTimers();
  setSystemTime(new Date("2026-11-12T12:00:00Z"));
  let expired = false;
  const stop = watchCredentialExpiry(Date.now() + 60_000, () => {
    expired = true;
  });
  stop();
  jest.advanceTimersByTime(60_001);
  expect(expired).toBe(false);
});
