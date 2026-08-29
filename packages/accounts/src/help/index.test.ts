import { describe, expect, test } from "bun:test";
import { accountsHelp } from ".";

describe("accountsHelp", () => {
  test("serves the existing Accounts help topics as English Markdown", async () => {
    expect(accountsHelp.documents.map((document) => document.id)).toEqual([
      "accounts-start",
      "accounts-admin",
      "accounts-lifecycle",
      "accounts-cli",
    ]);
    expect(accountsHelp.getMarkdown("accounts-start")).toContain("Accounts shows your own account context");
    expect(accountsHelp.getMarkdown("accounts-admin")).toContain("Admin pages are server-rendered lists");
    expect(accountsHelp.getMarkdown("accounts-lifecycle")).toContain("Direct membership");
    expect(accountsHelp.getMarkdown("accounts-cli")).toContain("The Accounts CLI uses the same");
  });

  test("translates every article to German with regional fallback", () => {
    const english = accountsHelp.documentsByLocale?.en ?? [];
    const german = accountsHelp.documentsByLocale?.de ?? [];
    expect(german.map((document) => document.id)).toEqual(english.map((document) => document.id));
    for (const document of german) {
      const base = english.find((candidate) => candidate.id === document.id);
      expect(base).toBeDefined();
      expect(document.icon).toBe(base!.icon);
      expect(document.order).toBe(base!.order);
    }
    expect(accountsHelp.getMarkdown("accounts-start", "de-CH")).toBe(accountsHelp.getMarkdown("accounts-start", "de"));
    expect(accountsHelp.getMarkdown("accounts-start", "de-CH")).toContain("Accounts zeigt deinen eigenen Kontokontext");
    expect(accountsHelp.getMarkdown("accounts-start", "fr")).toBe(accountsHelp.getMarkdown("accounts-start"));
  });
});
