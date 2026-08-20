import { describe, expect, test } from "bun:test";
import { resolveAiToolResultMaxChars } from "./tool-result-budget";

describe("AI tool result budget", () => {
  test("scales one result with the selected model context window", () => {
    expect(resolveAiToolResultMaxChars({ contextWindow: 16_000, configuredMaxChars: 2_000_000 })).toBe(32_000);
    expect(resolveAiToolResultMaxChars({ contextWindow: 128_000, configuredMaxChars: 2_000_000 })).toBe(256_000);
    expect(resolveAiToolResultMaxChars({ contextWindow: 1_000_000, configuredMaxChars: 2_000_000 })).toBe(2_000_000);
  });

  test("honors the operator ceiling", () => {
    expect(resolveAiToolResultMaxChars({ contextWindow: 1_000_000, configuredMaxChars: 50_000 })).toBe(50_000);
  });

  test("fits a full safety-bounded web extract into a 1M context model", () => {
    const maxChars = resolveAiToolResultMaxChars({ contextWindow: 1_000_000, configuredMaxChars: 2_000_000 });
    const serialized = JSON.stringify({ url: "https://example.com", content: "x".repeat(1_000_000), truncated: false });

    expect(serialized.length).toBeLessThan(maxChars);
  });

  test("uses a conservative fallback when the context window is unknown", () => {
    expect(resolveAiToolResultMaxChars({ configuredMaxChars: 2_000_000 })).toBe(8_000);
  });
});
