import { describe, expect, test } from "bun:test";
import { renderNotebookBook } from "./book-renderer";

const render = (markdown: string, locale = "en") => renderNotebookBook({ markdown, notebookId: "ABC123", locale }).html;

describe("Book table formula and inline parity", () => {
  test.each([
    ["=ROUND(Hours / 3, 2)", "0.67"],
    ["=ABS(-2)", "2"],
    ["=SQRT(9)", "3"],
    ["=POW(2, 3)", "8"],
    ["=MOD(7, 3)", "1"],
    ["=SUM(Hours)", "6"],
    ["=AVG(Hours)", "3"],
    ["=MEAN(Hours)", "3"],
    ["=MIN(Hours)", "2"],
    ["=MAX(Hours)", "4"],
    ["=COUNT(Name)", "2"],
    ["=MEDIAN(Hours)", "3"],
    ["=UNIQUE(Name)", "2"],
    ["=ROUND(STDEV(Hours), 2)", "1.41"],
    ['=COUNTIF(Name, "Ada")', "1"],
    ['=SUMIF(Hours, Name, "Ada")', "2"],
    ["=PERCENT(Hours, 8)", "25"],
    ["=ROWSUM()", "2"],
    ["=ROWAVG()", "2"],
    ["=ROWMEAN()", "2"],
    ['=IF(Hours < 3, "yes", "no")', "yes"],
    ['=IFEMPTY("", "fallback")', "fallback"],
    ['=IFERROR(1 / 0, "fallback")', "fallback"],
    ["=AND(Hours > 0, Hours < 3)", "1"],
    ["=OR(Hours == 0, Hours == 2)", "1"],
    ["=NOT(Hours == 0)", "1"],
    ['=CONTAINS(Name, "Ad")', "1"],
    ['=CONCAT(Name, "!")', "Ada!"],
    ["=UPPER(Name)", "ADA"],
    ["=LOWER(Name)", "ada"],
    ['=TRIM(" Ada ")', "Ada"],
    ["=LEFT(Name, 2)", "Ad"],
    ["=RIGHT(Name, 2)", "da"],
    ["=LEN(Name)", "3"],
    ["=SUBSTRING(Name, 1, 1)", "d"],
    ['=REPLACE(Name, "A", "a")', "ada"],
    ['=DATEDIFF("2026-09-01", "2026-09-05", "d")', "4"],
  ])("evaluates %s through the shared table engine", (formula, expected) => {
    const html = render(`| Name | Hours | Result |\n| --- | --- | --- |\n| Ada | 2 | ${formula} |\n| Grace | 4 | |`);
    expect(html).not.toContain("md-formula-error");
    expect(html).toContain(`</i>${expected}</span>`);
  });

  test("resolves computed columns and excludes the total cell", () => {
    const html = render(
      "| Hours | Rate | Total Cost |\n| ---: | ---: | ---: |\n| 2 | 10 | =Hours * Rate |\n| 3 | 20 | =Hours * Rate |\n| Total | | =SUM(`Total Cost`) |",
    );
    expect(html).toContain("</i>20</span>");
    expect(html).toContain("</i>60</span>");
    expect(html).toContain("</i>80</span>");
    expect(html).toContain('class="md-table-total-row"');
    expect(html).toContain("md-align-right");
    expect(html).not.toContain("md-formula-error");
  });

  test("retains localized progress, numeric results and safe formula errors", () => {
    const html = render(
      '| Value |\n| --- |\n| =1.5 |\n| =PROGRESS(1.5, 3) |\n| =PROGRESS(0.25) |\n| =1 / 0 |\n| =Value |\n| =CONCAT("<img src=x onerror=alert(1)>") |',
      "de",
    );
    expect(html).toContain("</i>1,5</span>");
    expect(html).toContain('style="width:50%"');
    expect(html).toContain("<span>1,5/3</span>");
    expect(html).toContain('style="width:25%"');
    expect(html).toContain("md-formula-error");
    expect(html).toContain("nicht durch null teilen");
    expect(html).toContain("Zirkelbezug");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("renders current date functions as values", () => {
    const html = render("| Value |\n| --- |\n| =TODAY() |\n| =NOW() |");
    expect(html).toMatch(/<\/i>\d{4}-\d{2}-\d{2}<\/span>/);
    expect(html).toMatch(/<\/i>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}<\/span>/);
    expect(html).not.toContain("md-formula-error");
  });

  test("keeps formula-looking code and formula return values literal", () => {
    const html = render('| Value |\n| --- |\n| `=SUM(Missing)` |\n| =CONCAT("**literal** $x$", " =SUM(Missing)") |');
    expect(html).toContain("<code>=SUM(Missing)</code>");
    expect(html).toContain("</i>**literal** $x$ =SUM(Missing)</span>");
    expect(html).not.toContain("md-formula-error");
    expect(html).not.toContain('class="katex"');
    expect(html).not.toContain("<strong>");
  });

  test("distinguishes complete highlight markup from a formula", () => {
    const html = render("| Value |\n| --- |\n| ==important== |\n| =1 == 1 |\n| ==broken |\n| =SUM(Missing) |");
    expect(html).toContain("<mark>important</mark>");
    expect(html).toContain("</i>1</span>");
    expect(html.match(/md-formula-error/g)?.length).toBe(2);
  });

  test("keeps GFM escaped pipes and reference links in their original cell context", () => {
    const html = render(
      "| Name | Result |\n| --- | --- |\n| Ada \\| Grace | =LEN(Name) |\n| [Guide][guide] | [**Home**](#heading-home) |\n\n[guide]: note://DEF456",
    );
    expect(html).toContain("Ada | Grace");
    expect(html).toContain("</i>11</span>");
    expect(html).toContain('href="/app/notebooks/ABC123/notes/DEF456?mode=book"');
    expect(html).toContain("<strong>Home</strong>");
    expect(html).not.toContain("md-formula-error");
  });

  test("renders math and Markdown through the same inline renderer as prose", () => {
    const html = render(
      "| **Name** | $x^2$ |\n| --- | --- |\n| [**Guide**](note://DEF456) | $\\frac{1}{2}$ |\n| `#literal` | ![Diagram](https://example.com/a.png) |\n| [Section](#heading-guide) | **bold and *italic*** |",
    );
    expect(html).toContain("<strong>Name</strong>");
    expect(html.match(/class="katex"/g)?.length).toBe(2);
    expect(html).toContain("<strong>Guide</strong>");
    expect(html).toContain('href="/app/notebooks/ABC123/notes/DEF456?mode=book"');
    expect(html).toContain("<code>#literal</code>");
    expect(html).toContain('src="https://example.com/a.png"');
    expect(html).toContain('href="#heading-guide"');
    expect(html).toContain("<strong>bold and <em>italic</em></strong>");
  });
});
