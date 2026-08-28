import { describe, expect, test } from "bun:test";
import { notebookHelp } from ".";

const expectedIds = [
  "notebooks-start",
  "notebooks-core-model",
  "notebooks-write-organize",
  "notebooks-structured-blocks",
  "notebooks-table-formulas",
  "notebooks-scripts",
  "notebooks-script-api",
  "notebooks-settings-access",
  "notebooks-troubleshooting",
];
const document = (id: string) => notebookHelp.documents.find((candidate) => candidate.id === id)!;

describe("notebookHelp", () => {
  test("keeps the reviewed topic order explicit", () => {
    expect(notebookHelp.documents.map((document) => document.id)).toEqual(expectedIds);
    for (const id of expectedIds) expect(notebookHelp.getMarkdown(id)?.length).toBeGreaterThan(20);
  });

  test("translates every topic and resolves regional locale fallbacks", () => {
    const english = notebookHelp.documentsByLocale?.en ?? [];
    const german = notebookHelp.documentsByLocale?.de ?? [];
    expect(german.map((document) => document.id)).toEqual(english.map((document) => document.id));
    for (const translated of german) {
      const base = english.find((candidate) => candidate.id === translated.id);
      expect(base).toBeDefined();
      expect(translated.icon).toBe(base!.icon!);
      expect(translated.order).toBe(base!.order);
    }
    expect(notebookHelp.getMarkdown("notebooks-start", "de-CH")).toContain("Notizbücher sind Arbeitsbereiche");
    expect(notebookHelp.getMarkdown("notebooks-start", "fr")).toBe(notebookHelp.getMarkdown("notebooks-start", "en")!);
  });

  test("keeps German articles structurally complete", () => {
    const count = (source: string, pattern: RegExp) => source.match(pattern)?.length ?? 0;
    for (const id of expectedIds) {
      const english = notebookHelp.getMarkdown(id, "en")!;
      const german = notebookHelp.getMarkdown(id, "de-CH")!;
      expect(german.length, `${id} must not be an abbreviated translation`).toBeGreaterThan(english.length * 0.65);
      expect(count(german, /^#{2,4} /gm), `${id} heading coverage`).toBe(count(english, /^#{2,4} /gm));
      expect(count(german, /^```/gm), `${id} code-fence coverage`).toBe(count(english, /^```/gm));
      expect(count(german, /^\|(?: *:?-+:? *\|)+$/gm), `${id} table coverage`).toBe(count(english, /^\|(?: *:?-+:? *\|)+$/gm));
    }
  });

  test("renders the complete corpus without leaking guided-help syntax", () => {
    for (const id of expectedIds) {
      const html = document(id).html;
      expect(html).not.toContain("<p>:::");
      expect(html).not.toContain('{icon="');
      expect(html).toMatch(/<h2 id="[^"]+"/);
    }
  });

  test("distinguishes guided steps from reference paths", () => {
    const html = document("notebooks-start").html;
    expect(html).toContain("<ol ");
    expect(html).toContain("<strong>Write:</strong>");
    expect(html).toContain("<ul ");
    expect(html).toContain("<strong>Capture notes:</strong>");
  });

  test("serves trusted-script guidance as inert documentation", () => {
    const scripts = document("notebooks-scripts");
    expect(scripts.markdown).toContain("Scripts are trusted JavaScript blocks for small notebook apps.");
    expect(scripts.markdown).toContain("Script blocks run in the browser of users who open the note.");
    expect(scripts.html).not.toContain("data-script-source");
    expect(scripts.html).toContain('<span class="hl-keyword">const</span>');
  });

  test("renders API and formula references as scannable tables", () => {
    const scriptHtml = document("notebooks-script-api").html;
    const formulaHtml = document("notebooks-table-formulas").html;

    expect(scriptHtml).toContain('<h3 id="current-metadata">Current metadata</h3>');
    expect(scriptHtml).toContain('<div class="md-table-wrap">');
    expect(scriptHtml).toContain(">What it does</span>");
    expect(scriptHtml).toContain(">await current.setContent(markdown)</code>");
    expect(scriptHtml).toContain(">string | null</code>");
    expect(scriptHtml).toContain(">Lock timestamp, or null when the note is not locked.</span>");
    expect(scriptHtml).not.toContain("<h5><code");

    expect(formulaHtml).toContain('<h3 id="progress-and-percentages">Progress and percentages</h3>');
    expect(formulaHtml).toContain('<div class="md-table-wrap">');
    expect(formulaHtml).toContain(">Result and notes</span>");
    expect(formulaHtml).toContain(">PROGRESS</code></span>");
  });
});
