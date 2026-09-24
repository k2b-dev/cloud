import { describe, expect, test } from "bun:test";
import { err } from "@k2b/stdlib";
import { localizeMailError, MAX_ERROR_DETAIL_LENGTH, safeErrorDetail } from "./error-messages";
import { providerBusy } from "./provider-operation-lock";

describe("Mail service messages", () => {
  test("preserves stable error metadata while translating German regional locales", () => {
    expect(localizeMailError(err.notFound("Mailbox"), "de-CH")).toEqual({
      code: "NOT_FOUND",
      message: "Das Postfach wurde nicht gefunden",
      status: 404,
    });
  });

  test("uses a useful German fallback and leaves other locales unchanged", () => {
    const error = err.badInput("A new provider constraint");
    expect(localizeMailError(error, "de-DE")).toEqual({ ...error, message: "Die Eingabe ist ungültig: A new provider constraint" });
    expect(localizeMailError(error, "fr")).toBe(error);
  });

  test("keeps the provider's explanation after the German invalid-input text", () => {
    const error = err.badInput("Provider authentication failed: AUTHENTICATIONFAILED Invalid credentials (Failure)");
    expect(localizeMailError(error, "de")).toEqual({
      ...error,
      message: "Die Eingabe ist ungültig: Provider authentication failed: AUTHENTICATIONFAILED Invalid credentials (Failure)",
    });
    expect(localizeMailError(err.badInput(" \n "), "de").message).toBe("Die Eingabe ist ungültig");
  });

  test("never shows credentials in an error detail", () => {
    const password = "hunter2-correct-horse";
    const detail = safeErrorDetail(
      `535 rejected ${password} for AUTH PLAIN AHVzZXJAZXhhbXBsZS5vcmcAaHVudGVyMg== password=hunter2 Bearer abc.def token: xyz ${"QUJD".repeat(10)}`,
      [password],
    );
    expect(detail).toBe(
      "535 rejected [redacted] for AUTH PLAIN [redacted] password=[redacted] Bearer [redacted] token=[redacted] [redacted]",
    );
    const localized = localizeMailError(err.badInput("Invalid login: AUTH PLAIN AHVzZXIAc2VjcmV0"), "de").message;
    expect(localized).toBe("Die Eingabe ist ungültig: Invalid login: AUTH PLAIN [redacted]");
  });

  test("bounds long error details", () => {
    const localized = localizeMailError(err.badInput(`TLS failed ${"x ".repeat(1_000)}`), "de").message;
    const detail = localized.slice("Die Eingabe ist ungültig: ".length);
    expect(detail.length).toBeLessThanOrEqual(MAX_ERROR_DETAIL_LENGTH);
    expect(detail.length).toBeGreaterThan(MAX_ERROR_DETAIL_LENGTH - 5);
    expect(detail.endsWith("…")).toBe(true);
  });

  test("names running synchronization instead of a generic conflict", () => {
    const error = providerBusy("Provider work is still running; retry credential replacement shortly");
    expect(localizeMailError(error, "de")).toEqual({
      code: "PROVIDER_BUSY",
      message: "Die Synchronisierung läuft gerade. Versuche es in einem Moment erneut.",
      status: 409,
    });
    expect(localizeMailError(error, "en")).toBe(error);
  });

  test("supports capability transport statuses", () => {
    const error = { code: "APP_UNAVAILABLE", message: "Provider unavailable", status: 503 as const };
    expect(localizeMailError(error, "de")).toEqual({
      ...error,
      message: "Mail ist vorübergehend nicht verfügbar. Versuche es gleich erneut.",
    });
  });
});
