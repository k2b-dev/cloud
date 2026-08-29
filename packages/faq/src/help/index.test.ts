import { describe, expect, test } from "bun:test";
import { faqHelp } from ".";

describe("faqHelp", () => {
  test("owns the existing FAQ help as Markdown", () => {
    expect(faqHelp.documents.map((document) => document.id)).toEqual(["faq-start", "faq-admin"]);

    expect(faqHelp.getMarkdown("faq-start")).toContain("FAQ publishes short answers");
    expect(faqHelp.getMarkdown("faq-start")).toContain("Logged-out visitors see anonymous entries.");
    expect(faqHelp.getMarkdown("faq-admin")).toContain("Use the user's wording for the question");
  });

  test("translates every article to German with regional fallback", () => {
    expect(faqHelp.documentsByLocale?.de?.map((document) => document.id)).toEqual(
      faqHelp.documentsByLocale?.en?.map((document) => document.id),
    );
    expect(faqHelp.getMarkdown("faq-start", "de-CH")).toBe(faqHelp.getMarkdown("faq-start", "de"));
    expect(faqHelp.getMarkdown("faq-start", "de-CH")).toContain("FAQ veröffentlicht kurze Antworten");
    expect(faqHelp.getMarkdown("faq-start", "fr")).toBe(faqHelp.getMarkdown("faq-start"));
  });
});
