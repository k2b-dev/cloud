import { describe, expect, test } from "bun:test";
import { capabilityMessages, checkCapabilityMessages } from "./capability-messages";

describe("capability framework messages", () => {
  test("keeps shipped catalogs complete and falls back from regional locales", () => {
    expect(checkCapabilityMessages()).toEqual([]);
    expect(capabilityMessages("de-CH").requestCancelled).toBe("Die Capability-Anfrage wurde abgebrochen");
    expect(capabilityMessages("fr").requestCancelled).toBe("Capability request was cancelled");
  });
});
