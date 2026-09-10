import { expect, test } from "bun:test";
import { isRetryableDictationError } from "./dictation-runtime";

test("retries only recognized transient Nessi failures", () => {
  for (const message of ["openai 429: limited", "openai-compatible 503: unavailable", "openai-compatible connection failed: refused"]) {
    expect(isRetryableDictationError(new Error(message))).toBe(true);
  }
  for (const message of [
    "openai 401: credentials",
    "openai-compatible 415: format",
    "openai-compatible returned invalid transcription JSON.",
    "Unknown error mentioning 503",
    "No audio model configured",
  ]) {
    expect(isRetryableDictationError(new Error(message))).toBe(false);
  }
});
