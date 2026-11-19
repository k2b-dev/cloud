import { describe, expect, test } from "bun:test";
import { err } from "@k2b/stdlib";
import { DRAFT_LEASE_ERROR_CODES } from "../contracts";
import { composeRenderFailure } from "./compose-render-errors";
import { localizeMailError, MAX_ERROR_DETAIL_LENGTH, safeErrorDetail } from "./error-messages";
import { providerBusy } from "./provider-operation-lock";
import { senderIdentityUnverified } from "./sender-identity-errors";

describe("Mail service messages", () => {
  test.each([
    ["DRAFT_DOCUMENT_HISTORY_UNAVAILABLE", 409],
    ["DRAFT_DOCUMENT_INVALID_HISTORY", 409],
    ["DRAFT_DOCUMENT_READ_UNAVAILABLE", 500],
  ])("%s offers draft recovery without hiding its code or status", (code, status) => {
    const error = { code, status, message: "Keep the device text and recover the draft" };
    for (const locale of ["de", "de-DE"]) {
      const localized = localizeMailError(error, locale);
      expect(localized).toMatchObject({ code, status });
      expect(localized.message).toContain("Sichere den Text");
      expect(localized.message).toContain("Postfach-Administration");
      expect(localized.message).not.toContain("Stand hat sich geändert");
    }
    expect(localizeMailError(error, "en")).toBe(error);
  });

  test.each([
    ["DOCUMENT_FROZEN", "The draft's editing state changed. Keep any text on this device and reopen the draft before editing."],
    ["CONFLICT", "The draft changed while loading. Keep any text on this device and reopen it."],
  ])("%s read failures keep read recovery guidance in German", (code, message) => {
    const error = { code, message, status: 409 as const };
    const localized = localizeMailError(error, "de");
    expect(localized).toMatchObject({ code, status: 409 });
    expect(localized.message).toContain("Sichere den Text");
    expect(localized.message).not.toContain("eingereiht");
    expect(localizeMailError(error, "en")).toBe(error);
  });

  test("localizes the missing send recipient without an English server detail", () => {
    const error = err.badInput("At least one recipient is required before sending");
    for (const locale of ["de", "de-DE", "de-CH"]) {
      expect(localizeMailError(error, locale)).toEqual({ ...error, message: "Gib mindestens eine Empfängeradresse an." });
    }
    expect(localizeMailError(error, "en")).toBe(error);
  });

  test("preserves stable error metadata while translating German regional locales", () => {
    expect(localizeMailError(err.notFound("Mailbox"), "de-CH")).toEqual({
      code: "NOT_FOUND",
      message: "Das Postfach wurde nicht gefunden",
      status: 404,
    });
  });

  test("shows a draft render failure as a complete sentence in the request language", () => {
    const failure = composeRenderFailure("tooManySignatures", 100);
    expect(localizeMailError(failure, "en").message).toBe("A message may contain at most 100 signatures. Remove some and try again.");
    expect(localizeMailError(failure, "de-AT")).toMatchObject({
      code: "BAD_INPUT",
      status: 400,
      message: "Eine Nachricht darf höchstens 100 Signaturen enthalten. Entferne einige und versuche es erneut.",
    });
    expect(localizeMailError(composeRenderFailure("tooComplex"), "fr").message).toBe(
      "This message is too complex to render safely. Shorten it or simplify its formatting.",
    );
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

  test("translates draft lease errors into German and preserves English messages", () => {
    const cases: Array<[string, string, string]> = [
      [DRAFT_LEASE_ERROR_CODES.HELD, "Draft is open in another session", "Dieser Entwurf ist gerade in einer anderen Sitzung geöffnet."],
      [
        DRAFT_LEASE_ERROR_CODES.NOT_OWNED,
        "Draft editing lease expired",
        "Die Bearbeitung dieses Entwurfs ist abgelaufen. Lade den Entwurf neu und versuche es erneut.",
      ],
      [DRAFT_LEASE_ERROR_CODES.BUSY, "Draft is being updated", "Der Entwurf wird gerade aktualisiert. Versuche es gleich erneut."],
    ];
    const translated = cases.map(([code, message]) => {
      const error = { code, message, status: 409 };
      expect(localizeMailError(error, "en")).toBe(error);
      return localizeMailError(error, "de");
    });
    expect(translated).toEqual(cases.map(([code, , message]) => ({ code, message, status: 409 })));
  });

  test("supports capability transport statuses", () => {
    const error = { code: "APP_UNAVAILABLE", message: "Provider unavailable", status: 503 as const };
    expect(localizeMailError(error, "de")).toEqual({
      ...error,
      message: "Mail ist vorübergehend nicht verfügbar. Versuche es gleich erneut.",
    });
  });
});

// The service creates a base-locale domain failure; all transports preserve its address and stable code.
test.each([null, "sender@example.test"])("sender identity failure carries a localizable address %j", (address) => {
  const error = senderIdentityUnverified(address);
  for (const locale of ["en", "de", "de-CH"]) {
    const localized = localizeMailError(error, locale);
    expect(localized).toMatchObject({ code: "SENDER_IDENTITY_UNVERIFIED", status: 400, senderAddress: address });
    expect(localized.message).toContain(locale === "en" ? "Sending identities" : "Absenderidentitäten");
    if (address) expect(localized.message).toContain(address);
  }
});

test.each([429, 503])("capability transport status %s has a localized retry hint", (status) => {
  const error = { code: "TRANSPORT_UNAVAILABLE", status, message: "Distinct English transport failure" };
  expect(localizeMailError(error, "en")).toBe(error);
  for (const locale of ["de", "de-CH"]) {
    const localized = localizeMailError(error, locale);
    expect(localized).toMatchObject({ code: error.code, status });
    expect(localized.message).toContain("Versuche es gleich erneut.");
    expect(localized.message).not.toContain(error.message);
  }
});
