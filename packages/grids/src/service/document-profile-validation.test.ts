import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { germanBillingProfile, germanEInvoiceProfile } from "../document-profiles/einvoice-de";
import { documentProfileInputMessage } from "../document-profiles/input-diagnostics";
import { createDocumentIssuanceService } from "./document-issuance";
import { validateDocumentProfileInput } from "./document-profile-validation";

const valid = () => ({
  invoiceDate: "2026-09-15",
  dueDate: "2026-09-30",
  currency: "EUR",
  seller: { name: "Provider", vatId: "DE123456789", address: { line1: "Street 1", city: "Ulm", postalCode: "89073", countryCode: "DE" } },
  buyer: { name: "Customer", vatId: "DE987654321", address: { line1: "Street 2", city: "Berlin", postalCode: "10115", countryCode: "DE" } },
  buyerReference: "ORDER-1",
  payment: { iban: "DE89370400440532013000", accountName: "Provider" },
  lines: [{ name: "Service", quantity: "1.0000", unitPrice: "10.0000", taxRate: "19.00" }],
});

describe("document profile input diagnostics", () => {
  test("renderer failures never echo raw errors in any locale", async () => {
    for (const locale of ["en", "de", "fr"])
      for (const error of [
        new Error("private renderer payload"),
        { code: "BAD_INPUT", status: 400, message: "private validator payload" },
      ]) {
        const issue = mock(async () => {
          throw error;
        });
        const service = createDocumentIssuanceService({ profiles: [{ ...germanEInvoiceProfile, issue }] });
        const result = await service.preview({
          profileId: germanEInvoiceProfile.id,
          profileVersion: germanEInvoiceProfile.version,
          snapshot: valid(),
          locale,
        });
        expect(issue).toHaveBeenCalledTimes(1);
        expect(result.ok).toBe(false);
        expect(JSON.stringify(result)).not.toContain("private");
      }
  });
  for (const profile of [germanEInvoiceProfile, germanBillingProfile]) {
    for (const locale of ["en", "de-DE"]) {
      test(`${profile.version}: missing parties and bank details are actionable in ${locale}`, async () => {
        const input = { ...valid(), seller: null, buyer: null, payment: { iban: null, accountName: null } };
        const validated = validateDocumentProfileInput(profile, input, locale);
        expect(validated.ok).toBe(false);
        if (validated.ok) return;
        expect(validated.error.code).toBe("BAD_INPUT");
        expect(validated.error.message).toContain(locale === "en" ? "Service provider" : "Leistungserbringer");
        expect(validated.error.message).toContain(locale === "en" ? "Customer" : "Kunde");
        expect(validated.error.message).toContain("IBAN");
        expect(validated.error.message).toContain(locale === "en" ? "Save" : "Speichere");
        expect(validated.error.message).not.toMatch(/expected|received|invalid_type|seller\.|buyer\./i);
        const issue = mock(profile.issue);
        const service = createDocumentIssuanceService({ profiles: [{ ...profile, issue }] });
        const preview = await service.preview({ profileId: profile.id, profileVersion: profile.version, snapshot: input, locale });
        expect(preview).toEqual(validated);
        expect(issue).not.toHaveBeenCalled();
      });
    }
  }

  test("invalid IBAN identifies the required correction without echoing the value", () => {
    const input = valid();
    input.payment.iban = "DE00370400440532013000";
    for (const locale of ["en", "de"]) {
      const result = validateDocumentProfileInput(germanEInvoiceProfile, input, locale);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.message).toContain(locale === "en" ? "checksum" : "Prüfsumme");
      expect(result.error.message).not.toContain(input.payment.iban);
    }
  });

  test("unknown profile paths get localized recovery guidance without raw validator messages", () => {
    const parsed = z.object({ payload: z.object({ total: z.number() }) }).safeParse({ payload: { total: "private-value" } });
    if (parsed.success) throw new Error("Expected invalid input");
    const en = documentProfileInputMessage("custom.profile", parsed.error.issues, "en");
    const de = documentProfileInputMessage("custom.profile", parsed.error.issues, "de");
    expect(en).toContain("Field payload.total");
    expect(de).toContain("Feld payload.total");
    expect(de).toContain("Feldzuordnung");
    expect(en).not.toContain("private-value");
    expect(de).not.toContain("expected");
  });

  test("valid input keeps the existing validation return contract", () => {
    const input = valid();
    expect(validateDocumentProfileInput(germanEInvoiceProfile, input, "de")).toEqual({ ok: true, data: input });
  });
});
