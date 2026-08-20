import { describe, expect, test } from "bun:test";
import { spacesHelp } from ".";

describe("spacesHelp", () => {
  test("owns the existing Spaces help topics as Markdown", () => {
    expect(spacesHelp.documents.map((document) => document.id)).toEqual([
      "spaces-start",
      "spaces-views",
      "spaces-workflow",
      "spaces-sharing",
      "spaces-troubleshooting",
    ]);

    expect(spacesHelp.getMarkdown("spaces-start")).toContain("Spaces is for shared work");
    expect(spacesHelp.getMarkdown("spaces-troubleshooting")).toContain("A space is missing from the overview");
    expect(spacesHelp.getMarkdown("spaces-workflow")).toContain("**Estimated duration:**");
    expect(spacesHelp.getMarkdown("spaces-workflow")).toContain("**Blocked by:**");
    expect(spacesHelp.getMarkdown("spaces-workflow")).toContain("**Blocks:**");
    expect(spacesHelp.getMarkdown("spaces-workflow")).toContain("**Related tasks:**");
    expect(spacesHelp.getMarkdown("spaces-troubleshooting")).toContain("A task cannot be completed");
  });
});
