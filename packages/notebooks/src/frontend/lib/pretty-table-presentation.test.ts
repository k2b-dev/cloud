import { describe, expect, test } from "bun:test";
import { createPrettyTablePresentation, renderPrettyTableHtml } from "./pretty-table";

describe("pretty table cell presentation", () => {
  test("preserves the existing complete HTML byte for byte", () => {
    const html = renderPrettyTableHtml(
      {
        caption: "budget",
        headers: ["Hours", "Cost"],
        rows: [
          ["**Work**", "=1.5"],
          ["Sum", "=SUM(Cost)"],
        ],
        align: [null, "right"],
      },
      { locale: "de", notebookId: "ABC123" },
    );
    // Captured from the original renderer before extracting cell presentation.
    expect(html).toBe(
      '<div class="md-block-handle" data-block-name="budget">@budget</div><div class="md-table-wrap"><table class="md-table"><thead><tr><th scope="col"><span class="md-table-cell">Hours</span></th><th scope="col"><span class="md-table-cell md-align-right">Cost</span></th></tr></thead><tbody><tr><td><span class="md-table-cell"><strong>Work</strong></span></td><td><span class="md-table-cell md-formula-ok md-align-right" title="=1.5"><i class="ti ti-math-function"></i>1,5</span></td></tr><tr class="md-table-total-row"><td><span class="md-table-cell">Sum</span></td><td><span class="md-table-cell md-formula-ok md-align-right" title="=SUM(Cost)"><i class="ti ti-math-function"></i>1,5</span></td></tr></tbody></table></div>',
    );
  });

  test("cell and full-table rendering share progress, errors and delegated inline rendering", () => {
    const data = { headers: ["Count", "Progress", "Error"], rows: [["**Work**", "=PROGRESS(1, 4)", "=1/0"]] };
    const options = { locale: "de", renderInline: (raw: string) => `<em>${raw}</em>` };
    const presentation = createPrettyTablePresentation(data, options);
    const html = renderPrettyTableHtml(data, options);
    expect(presentation.headerHtml(0)).toContain("<em>Count</em>");
    expect(presentation.cellHtml(0, 0)).toContain("<em>**Work**</em>");
    expect(presentation.cellHtml(0, 1)).toContain('style="width:25%"');
    expect(presentation.cellHtml(0, 2)).toContain("nicht durch null teilen");
    for (let column = 0; column < 3; column++) expect(html).toContain(`<td>${presentation.cellHtml(0, column)}</td>`);
  });

  test("legacy full rendering keeps its header-width contract", () => {
    const data = { headers: ["A"], rows: [["first", "extra"]] };
    expect(renderPrettyTableHtml(data)).not.toContain("extra");
    expect(data.rows[0]).toEqual(["first", "extra"]);
  });
});
