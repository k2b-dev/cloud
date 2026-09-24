import { describe, expect, test } from "bun:test";
import { err } from "@k2b/stdlib";
import { localizeMailError } from "./error-messages";
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
    expect(localizeMailError(error, "de-DE")).toEqual({ ...error, message: "Die Eingabe ist ungültig" });
    expect(localizeMailError(error, "fr")).toBe(error);
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
