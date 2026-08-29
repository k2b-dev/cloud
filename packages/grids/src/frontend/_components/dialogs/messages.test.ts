import { describe, expect, test } from "bun:test";
import { gridsDialogMessages } from "./messages";

describe("gridsDialogMessages", () => {
  test("keeps English as the base locale", () => {
    expect(gridsDialogMessages.resolve([]).t.combinedData).toBe("Combined data");
  });

  test("resolves regional German locales and structured diagnostics", () => {
    const { t } = gridsDialogMessages.resolve(["de-CH"]);
    expect(t.historyProtection).toBe("Verlauf und Schutz");
    expect(t.federatedDiagnostic({ code: "source_required", fallback: "ignored" })).toContain("Quelltabelle");
    expect(t.deleteTableConfirm({ name: "Bestellungen" })).toContain("Dateien und der Audit-Verlauf");
  });
});
