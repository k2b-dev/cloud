import { describe, expect, test } from "bun:test";
import { compileBaseFieldColumn, fieldProjection, isImplicitlySelectableField } from "../query-dsl/sql-compiler-fields";
import { createHtmlTemplateRenderBudget, enrichRecordsWithHtmlTemplates, renderHtmlTemplateValue } from "../service/html-template-fields";
import type { Field, GridRecord } from "../service/types";
import { HTML_TEMPLATE_ERROR, htmlTemplateHandler, validateHtmlTemplateCss } from "./html-template";

const field: Field = {
  id: "00000000-0000-7000-8000-000000000001",
  shortId: "html01",
  tableId: "00000000-0000-7000-8000-000000000002",
  name: "HTML",
  description: null,
  type: "html_template",
  config: { template: "<p>Hello</p>", css: "" },
  position: 0,
  required: false,
  presentable: false,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("HTML template field", () => {
  test("validates the supported config and Liquid roots", () => {
    expect(
      htmlTemplateHandler.configSchema.safeParse({ template: "<p>{{ record.data.title }}</p>", css: "p { color: red; }" }).success,
    ).toBe(true);
    const invalid = htmlTemplateHandler.configSchema.safeParse({ template: "{{ secret.value }}", css: "" });
    expect(invalid.success).toBe(false);
    if (!invalid.success) expect(invalid.error.issues[0]?.message).toContain('unknown Liquid variable "secret"');
  });

  test("accepts an empty initial config and rejects malformed CSS", () => {
    expect(htmlTemplateHandler.configSchema.parse({})).toEqual({ template: "", css: "" });
    expect(validateHtmlTemplateCss("p { color: red")).toContain("Unclosed block");
  });

  test("escapes record values and inlines CSS", async () => {
    const rendered = await renderHtmlTemplateValue(
      { template: '<p class="title">{{ record.data.title }}</p>', css: ".title { color: red; }" },
      { record: { data: { title: "<strong>Ada</strong>" } } },
    );
    expect(rendered.ok).toBe(true);
    if (rendered.ok) {
      expect(rendered.data).toContain('style="color: red;"');
      expect(rendered.data).toContain("&lt;strong&gt;Ada&lt;&#x2F;strong&gt;");
    }
  });

  test("keeps a stable runtime error sentinel", () => {
    expect(HTML_TEMPLATE_ERROR).toBe("#TEMPLATE_ERROR!");
  });

  test("handles empty and invalid persisted configs without loading shared context", async () => {
    const record = {
      id: "00000000-0000-7000-8000-000000000003",
      shortId: "rec001",
      tableId: field.tableId,
      data: {} as Record<string, unknown>,
      version: 1,
      deletedAt: null,
      createdBy: null,
      updatedBy: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } satisfies GridRecord;
    const emptyField = { ...field, config: { template: "", css: "" } };
    const invalidField = { ...field, id: "00000000-0000-7000-8000-000000000004", config: null as never };

    await enrichRecordsWithHtmlTemplates([record], [emptyField, invalidField]);

    expect(record.data[emptyField.id]).toBe("");
    expect(record.data[invalidField.id]).toBe(HTML_TEMPLATE_ERROR);
  });

  test("shares elapsed Liquid time across cells and stops an exhausted batch", async () => {
    const budget = {
      remainingCells: 2_000,
      remainingRenderMs: 100,
      remainingInlineWorkBytes: 32 * 1024 * 1024,
      remainingOutputBytes: 32 * 1024 * 1024,
      exhausted: false,
      warningLogged: false,
    };
    const config = {
      template: "{% for a in (1..1000) %}{% for b in (1..1000) %}{% for c in (1..1000) %}{% endfor %}{% endfor %}{% endfor %}",
      css: "",
    };
    const start = performance.now();
    for (let i = 0; i < 5; i++) expect((await renderHtmlTemplateValue(config, {}, budget)).ok).toBe(false);
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(budget.exhausted).toBe(true);
    expect(budget.remainingRenderMs).toBeLessThanOrEqual(0);
    expect(createHtmlTemplateRenderBudget().remainingRenderMs).toBe(2_000);
  });

  test("stops before CSS inlining when the shared batch budget is exhausted", async () => {
    const budget = createHtmlTemplateRenderBudget();
    budget.remainingInlineWorkBytes = 1;
    const rendered = await renderHtmlTemplateValue({ template: "<p>Hello</p>", css: "" }, {}, budget);

    expect(rendered.ok).toBe(false);
    expect(budget.exhausted).toBe(true);
  });

  test("stops before loading shared context when cancelled or out of batch cells", async () => {
    const record = {
      id: "00000000-0000-7000-8000-000000000003",
      shortId: "rec001",
      tableId: field.tableId,
      data: {} as Record<string, unknown>,
      version: 1,
      deletedAt: null,
      createdBy: null,
      updatedBy: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } satisfies GridRecord;
    const budget = createHtmlTemplateRenderBudget();
    budget.remainingCells = 0;

    await enrichRecordsWithHtmlTemplates([record], [field], { budget });
    expect(record.data[field.id]).toBe(HTML_TEMPLATE_ERROR);

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(enrichRecordsWithHtmlTemplates([{ ...record, data: {} }], [field], { signal: controller.signal })).rejects.toThrow(
      "cancelled",
    );
  });

  test("requires explicit primary-row GQL selection and stays unavailable to SQL expressions", () => {
    expect(isImplicitlySelectableField(field)).toBe(false);
    expect(fieldProjection(field, "r").ok).toBe(false);
    const selected = compileBaseFieldColumn({
      field,
      fields: [field],
      recordAlias: "r",
      index: 0,
      tableId: field.tableId,
    });
    expect(selected.ok).toBe(true);
    if (selected.ok) expect(selected.column).toMatchObject({ fieldId: field.id, type: "html_template", sqlType: "text" });
  });
});
