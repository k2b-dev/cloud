import { describe, expect, test } from "bun:test";
import { err } from "@k2b/stdlib";
import { localizeMailError } from "./error-messages";

describe("Mail service messages", () => {
  test("preserves stable error metadata while translating German regional locales", () => {
    expect(localizeMailError(err.notFound("Mailbox"), "de-CH")).toEqual({
      code: "NOT_FOUND",
      message: "Die angeforderte Mail-Ressource wurde nicht gefunden",
      status: 404,
    });
  });

  test("uses a useful German fallback and leaves other locales unchanged", () => {
    const error = err.badInput("A new provider constraint");
    expect(localizeMailError(error, "de-DE")).toEqual({ ...error, message: "Die Eingabe ist ungültig" });
    expect(localizeMailError(error, "fr")).toBe(error);
  });

  test("supports capability transport statuses", () => {
    const error = { code: "APP_UNAVAILABLE", message: "Provider unavailable", status: 503 as const };
    expect(localizeMailError(error, "de")).toEqual({
      ...error,
      message: "Mail ist vorübergehend nicht verfügbar. Versuche es gleich erneut.",
    });
  });
});
