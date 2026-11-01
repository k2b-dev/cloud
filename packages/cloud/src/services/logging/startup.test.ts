import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { initializeTestPlatform } from "../../../../../scripts/fixtures/test-infra";
import { closePlatformClients } from "../../runtime/clients";
import { logger } from ".";

const warn = spyOn(console, "warn").mockImplementation(() => {});
const error = spyOn(console, "error").mockImplementation(() => {});
afterAll(() => {
  warn.mockRestore();
  error.mockRestore();
});
afterEach(() => {
  warn.mockClear();
  error.mockClear();
});

test("logger before start does not throw and keeps console output", async () => {
  await closePlatformClients();
  expect(() => logger("startup").warn("original failure")).not.toThrow();
  expect(warn).toHaveBeenCalledWith("[startup]", "original failure");
  await Promise.resolve();
  expect(error).toHaveBeenCalledWith("[logging] DB write failed:", "sql used before platform start");
});

test("logger after client teardown does not mask the original failure", async () => {
  await initializeTestPlatform();
  await closePlatformClients();
  expect(() => logger("shutdown").warn("original failure")).not.toThrow();
  expect(warn).toHaveBeenCalledWith("[shutdown]", "original failure");
  await Promise.resolve();
  expect(error).toHaveBeenCalledWith("[logging] DB write failed:", "sql used before platform start");
});
