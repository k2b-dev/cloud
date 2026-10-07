import { afterEach, expect, test } from "bun:test";
import { CORE_SETTINGS } from "./core-settings";

const previous = process.env.GOTENBERG_URL;
afterEach(() => {
  if (previous === undefined) delete process.env.GOTENBERG_URL;
  else process.env.GOTENBERG_URL = previous;
});

test("GOTENBERG_URL bootstraps and backs the gotenberg.url setting", () => {
  const setting = CORE_SETTINGS["gotenberg.url"];
  process.env.GOTENBERG_URL = "http://gotenberg:3000";
  expect(setting.envBootstrap()).toBe("http://gotenberg:3000");
  expect(setting.envFallback()).toBe("http://gotenberg:3000");

  delete process.env.GOTENBERG_URL;
  expect(setting.envBootstrap()).toBeUndefined();
  expect(setting.envFallback()).toBeUndefined();
});

test("outgoing mail SMTP settings are no longer registered", () => {
  expect(Object.keys(CORE_SETTINGS).filter((key) => key.startsWith("mail.noreply."))).toEqual([]);
});
