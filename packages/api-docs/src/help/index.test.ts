import { describe, expect, test } from "bun:test";
import { apiDocsHelp } from ".";

describe("apiDocsHelp", () => {
  test("owns the API Docs overview guidance as Markdown", () => {
    expect(apiDocsHelp.documents.map((document) => document.id)).toEqual(["api-docs-start"]);

    expect(apiDocsHelp.getMarkdown("api-docs-start")).toContain("Start here before choosing an app");
    expect(apiDocsHelp.getMarkdown("api-docs-start")).toContain("cld api-docs search");
  });

  test("serves the complete German article with regional fallback", () => {
    expect(apiDocsHelp.documentsByLocale?.de?.map((document) => document.id)).toEqual(
      apiDocsHelp.documentsByLocale?.en?.map((document) => document.id),
    );
    expect(apiDocsHelp.getMarkdown("api-docs-start", "de-CH")).toBe(apiDocsHelp.getMarkdown("api-docs-start", "de"));
    expect(apiDocsHelp.getMarkdown("api-docs-start", "de-CH")).toContain("API Docs bündelt die OpenAPI-Referenzen");
    expect(apiDocsHelp.getMarkdown("api-docs-start", "fr")).toBe(apiDocsHelp.getMarkdown("api-docs-start"));
  });
});
