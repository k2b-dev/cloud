import { describe, expect, test } from "bun:test";
import { builtInPageTemplates } from "../templates/pages";
import { deriveNoteTitle } from "./note-title";
import {
  isBlankPage,
  isBuiltInPageTemplateId,
  normalizePageTemplateName,
  PAGE_TEMPLATE_NAME_MAX_LENGTH,
  pageTemplateBody,
  renderPageTemplate,
} from "./page-templates";

const values = { date: "2026-11-04", author: "Ada Lovelace" };

describe("renderPageTemplate", () => {
  test("fills in date and author, with or without spaces inside the braces", () => {
    expect(renderPageTemplate("# Meeting {{date}}\n\nBy {{ author }} on {{date}}", values)).toBe(
      "# Meeting 2026-11-04\n\nBy Ada Lovelace on 2026-11-04",
    );
  });

  test("keeps every other placeholder as typed, so code samples survive", () => {
    const content = "```handlebars\n{{title}} {{#each items}}\n```\n{date} {{ dates }}";
    expect(renderPageTemplate(content, values)).toBe(content);
  });

  test("an unknown author leaves the field empty instead of a placeholder", () => {
    expect(renderPageTemplate("- **By:** {{author}}", { ...values, author: "" })).toBe("- **By:** ");
  });
});

describe("isBlankPage", () => {
  test("a note with no text or only its title is blank", () => {
    expect(isBlankPage("")).toBe(true);
    expect(isBlankPage("\n\n  \n")).toBe(true);
    expect(isBlankPage("# New Document\n")).toBe(true);
    expect(isBlankPage("\n# New Document\n\n\n")).toBe(true);
  });

  test("any line below the title, or a first line that is not a title, makes it a note with content", () => {
    expect(isBlankPage("# Plan\n\nFirst idea")).toBe(false);
    expect(isBlankPage("Plain first line")).toBe(false);
    expect(isBlankPage("## Section only")).toBe(false);
  });
});

describe("pageTemplateBody", () => {
  test("drops the title and the blank lines below it", () => {
    expect(pageTemplateBody("# Meeting\n\n## Agenda\n\n1.\n")).toBe("## Agenda\n\n1.\n");
  });

  test("keeps a template without a title whole", () => {
    expect(pageTemplateBody("## Agenda\n- [ ] Item")).toBe("## Agenda\n- [ ] Item");
  });
});

describe("normalizePageTemplateName", () => {
  test("trims and collapses spaces; blank or too long names are refused", () => {
    expect(normalizePageTemplateName("  Weekly   sync ")).toBe("Weekly sync");
    expect(normalizePageTemplateName("   ")).toBeNull();
    expect(normalizePageTemplateName("x".repeat(PAGE_TEMPLATE_NAME_MAX_LENGTH))).toHaveLength(PAGE_TEMPLATE_NAME_MAX_LENGTH);
    expect(normalizePageTemplateName("x".repeat(PAGE_TEMPLATE_NAME_MAX_LENGTH + 1))).toBeNull();
  });
});

describe("built-in page templates", () => {
  test("their IDs never look like the short ID of an own template", () => {
    for (const template of builtInPageTemplates) expect(isBuiltInPageTemplateId(template.id)).toBe(true);
    expect(isBuiltInPageTemplateId("Ab12Cd")).toBe(false);
    expect(isBuiltInPageTemplateId("decision")).toBe(false);
  });

  test("each language gives a titled page with sections, a table and a task list, and only known placeholders", () => {
    for (const template of builtInPageTemplates) {
      for (const localized of [template.en, template.de]) {
        const rendered = renderPageTemplate(localized.content, values);
        expect(deriveNoteTitle(rendered)).not.toBe("Untitled");
        expect(localized.content.startsWith("# ")).toBe(true);
        expect(rendered).toMatch(/^## /m);
        expect(rendered).toMatch(/^\| --- \|/m);
        expect(rendered).toMatch(/^- \[ \] $/m);
        expect(rendered).toContain(values.author);
        expect(rendered).not.toContain("{{");
        expect(localized.name.length).toBeGreaterThan(0);
        expect(localized.description.length).toBeGreaterThan(0);
      }
      // Both languages have the same structure, so a notebook reads the same in either.
      const shape = (content: string) => content.split("\n").map((line) => line.match(/^(#+|\||- \[ \]|- \*\*|1\.)/)?.[1] ?? "");
      expect(shape(template.de.content)).toEqual(shape(template.en.content));
    }
  });
});
