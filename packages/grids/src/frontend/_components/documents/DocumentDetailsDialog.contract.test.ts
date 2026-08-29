import { describe, expect, test } from "bun:test";
import { documentMessages } from "./messages";

describe("document details", () => {
  test("shows every immutable artifact and offers an explicit new generation", async () => {
    const details = await Bun.file(new URL("./DocumentDetailsDialog.tsx", import.meta.url)).text();
    const workspace = await Bun.file(new URL("./DocumentTemplateWorkspace.tsx", import.meta.url)).text();

    expect(documentMessages.resolve(["en"]).t.completedDocument).toBe("Completed document");
    expect(documentMessages.resolve(["de-CH"]).t.completedDocument).toBe("Abgeschlossenes Dokument");
    expect(details).not.toContain("re-rendered");
    expect(details).toContain("SHA-256");
    expect(details).toContain("artifact.key");
    expect(details).toContain("t().generateAgain");
    expect(workspace).toContain('openGenerate(item.recordId, "generate-again")');
  });
});
