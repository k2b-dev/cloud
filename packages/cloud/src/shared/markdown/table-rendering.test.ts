import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { markdown } from "./index";

describe("markdown tables", () => {
  test("renders the shared table structure and column alignment", () => {
    const html = markdown.renderSync(`| Item | Amount |
|---|---:|
| Flour | 400 |`);

    expect(html).toContain('<div class="md-table-wrap">');
    expect(html).toContain('<table class="md-table">');
    expect(html).toContain('class="md-table-cell md-align-right"');
    expect(html).toContain('<span class="md-table-cell">Flour</span>');
  });

  test("preserves formula and summary-row semantics", () => {
    const html = markdown.renderSync(`| Item | Amount |
|---|---:|
| Flour | 400 |
| Total | =SUM(Amount) |`);

    expect(html).toContain('class="md-table-total-row"');
    expect(html).toContain("md-formula-ok md-align-right");
    expect(html).toContain("ti-math-function");
    expect(html).toContain(">400</span>");
  });

  test("keeps the table frame content-height driven", () => {
    const styles = readFileSync(resolve(import.meta.dir, "../../styles/utilities-markdown-table.css"), "utf8");
    const wrapper = styles.slice(styles.indexOf(".md-table-wrap"), styles.indexOf(".md-table {"));

    expect(wrapper).toContain("overflow: clip");
    expect(wrapper).not.toContain("overflow-x");
    expect(styles).toContain("overflow-wrap: anywhere");
  });

  test("keeps help table emphasis and paint on structural rows", () => {
    const styles = readFileSync(resolve(import.meta.dir, "../../styles/effects.css"), "utf8");

    expect(styles).toContain(`.help-document .md-table-wrap {
  overflow: hidden;`);
    expect(styles).toContain(".help-document .md-table-wrap > .md-table");
    expect(styles).toContain("border-collapse: separate");
    expect(styles).toContain("border-spacing: 0");
    expect(styles).toContain(`.help-document .md-table :is(th, td) {
  min-width: 0;
  height: auto;
  padding: 0;
}`);
    expect(styles).toContain("overflow-wrap: break-word");
    expect(styles).toContain("word-break: normal");
    // The header has no fill; a stronger line under it marks the header.
    expect(styles).not.toContain(".help-document .md-table thead {");
    expect(styles).toContain(".help-document .md-table tbody tr:not(.md-table-total-row):hover");
    expect(styles).toContain(".help-document .md-table tbody tr:not(.md-table-total-row) .md-table-cell :where(strong)");
    expect(styles).not.toContain(".help-document .md-table thead .md-table-cell {\n  background:");
    expect(styles).not.toContain(".help-document .md-table tbody tr:nth-child(even)");
    expect(styles).not.toContain(".help-document .md-table td:first-child .md-table-cell");
  });
});
