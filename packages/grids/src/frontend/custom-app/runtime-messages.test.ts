import { describe, expect, test } from "bun:test";
import { customAppRuntimeMessages } from "./runtime-messages";

describe("custom App runtime messages", () => {
  test("uses German for regional German locales", () => {
    const messages = customAppRuntimeMessages.resolve(["de-CH"]).t;

    expect(messages.records).toBe("Datensätze");
    expect(messages.noRecordsMatch({ query: "offen" })).toBe("Keine Datensätze stimmen mit „offen“ überein.");
  });

  test("falls back to English for unsupported locales", () => {
    const messages = customAppRuntimeMessages.resolve(["fr"]).t;

    expect(messages.records).toBe("Records");
    expect(messages.workflowStartFailed).toBe("The workflow could not be started.");
  });
});
