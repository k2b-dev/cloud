import { describe, expect, test } from "bun:test";
import { type HealthWebhookInput, HealthWebhookInputError, isHealthWebhookId, normalizeHealthWebhookInput } from "./health-webhooks";

const input = (overrides: Partial<HealthWebhookInput> = {}): HealthWebhookInput => ({
  name: "Deploy alerts",
  url: "https://example.com/hook",
  method: "POST",
  enabled: true,
  scopeKind: "all",
  scopeAppIds: [],
  sendOn: ["error", "recovery"],
  minStatus: "error",
  repeatIntervalMs: 1_800_000,
  timeoutMs: 5000,
  ...overrides,
});

describe("isHealthWebhookId", () => {
  test("accepts uuid ids and rejects arbitrary route params before SQL casts", () => {
    expect(isHealthWebhookId("00000000-0000-4000-8000-000000000000")).toBe(true);
    expect(isHealthWebhookId("not-a-uuid")).toBe(false);
  });
});

describe("normalizeHealthWebhookInput", () => {
  test("normalizes URL, trims name, deduplicates scope ids, and applies defaults", () => {
    const normalized = normalizeHealthWebhookInput(
      input({
        name: "  Deploy alerts  ",
        url: "https://example.com/hook?x=1",
        scopeAppIds: ["contacts", "contacts", " dashboard "],
        sendOn: [],
        repeatIntervalMs: 30_000,
        timeoutMs: 500,
      }),
    );

    expect(normalized.name).toBe("Deploy alerts");
    expect(normalized.url).toBe("https://example.com/hook?x=1");
    expect(normalized.scopeAppIds).toEqual(["contacts", "dashboard"]);
    expect(normalized.sendOn).toEqual(["error", "recovery"]);
    expect(normalized.repeatIntervalMs).toBe(60_000);
    expect(normalized.timeoutMs).toBe(1000);
  });

  test("rejects empty names and non-http URLs", () => {
    expect(() => normalizeHealthWebhookInput(input({ name: "   " }))).toThrow(
      expect.objectContaining({ name: "HealthWebhookInputError", code: "name_required" }),
    );
    expect(() => normalizeHealthWebhookInput(input({ url: "ftp://example.com/hook" }))).toThrow(
      expect.objectContaining({ name: "HealthWebhookInputError", code: "url_protocol" }),
    );
    expect(new HealthWebhookInputError("name_required").message).toBe("name_required");
  });
});
