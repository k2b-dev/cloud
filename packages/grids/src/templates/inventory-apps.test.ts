import { describe, expect, test } from "bun:test";
import { createInventoryTemplate } from "./inventory";
import { field, fieldKey, form, launcher } from "./types";

type Block = Record<string, unknown>;
type Page = { id: string; availableWhen?: unknown; rows: Array<{ columns: Array<{ blocks: Block[] }> }> };
const app = (locale: string, key: string) => {
  const template = createInventoryTemplate(locale);
  const definition = template.customApps!.find((app) => app.key === key)!.definition;
  return { template, definition, pages: definition.pages as Page[] };
};
const blocks = (page: Page) => page.rows.flatMap((row) => row.columns.flatMap((column) => column.blocks));

describe("inventory audience journeys", () => {
  for (const locale of ["en", "de"]) {
    test(`${locale}: borrower requests are fixed to visible kits and private loan details remain actor-scoped`, () => {
      const { template, definition, pages } = app(locale, "equipment_loans");
      expect(definition.sidebar).toBeUndefined();
      expect(template.forms!.find((form) => form.key === "request_loan")!.isPublic).toBe(false);
      const kit = pages.find((page) => page.id === "kit")!;
      expect(JSON.stringify(kit.availableWhen)).toContain("kits.requestable");
      expect(JSON.stringify(kit.availableWhen)).toContain("kits.status");
      expect(blocks(kit).find((block) => block.id === "request")).toMatchObject({
        formId: form("request_loan"),
        fixedValues: { [fieldKey("loans.kits")]: { source: "RECORD", path: "id" } },
        presentation: { kind: "dialog" },
      });
      const loan = pages.find((page) => page.id === "loan")!;
      expect(JSON.stringify(loan.availableWhen)).toContain("record.createdBy = @auth.id");
      const borrowerDefinition = JSON.stringify(definition);
      for (const privateField of ["items.notes", "items.replacement_value", "items.total_value", "kits.notes", "loans.notes"]) {
        expect(borrowerDefinition).not.toContain(`"key":"${privateField}"`);
      }
    });

    test(`${locale}: the desk keeps actions ahead of lists and contact corrections available`, () => {
      const { pages } = app(locale, "loan_desk");
      const loan = pages.find((page) => page.id === "loan")!;
      const all = blocks(loan);
      expect(all.findIndex((block) => block.id === "actions")).toBeLessThan(all.findIndex((block) => block.id === "loan-positions"));
      expect(all.find((block) => block.id === "details")).toMatchObject({
        editableFieldIds: [field("loans.requester_name"), field("loans.requester_email"), field("loans.organization")],
      });
      expect(all.find((block) => block.id === "notes")).toMatchObject({ editableFieldIds: [field("loans.notes")] });
      for (const id of ["loan-positions", "add-position"])
        expect(all.find((block) => block.id === id)).toMatchObject({ display: { mobile: expect.any(Object) } });
      const borrower = app(locale, "equipment_loans").pages.find((page) => page.id === "loan")!;
      expect(blocks(borrower).find((block) => block.id === "identity")).toMatchObject({ documents: { templateIds: expect.any(Array) } });
      expect(JSON.stringify(blocks(borrower).find((block) => block.id === "identity"))).not.toContain('"preview":true');
    });

    test(`${locale}: returns use the same workflow from item dialog and scanner`, () => {
      const { template, pages } = app(locale, "loan_desk");
      const item = pages.find((page) => page.id === "item")!;
      expect(blocks(item).find((block) => block.id === "return")).toMatchObject({
        actions: [
          {
            launcherId: launcher("return_loan_item_custom_app"),
            inputs: { item: { source: "RECORD", path: "id" } },
            prompt: { inputs: ["condition"] },
          },
        ],
      });
      expect(template.workflowLaunchers!.find((launcher) => launcher.key === "return_loan_item_custom_app")!.workflow).toBe(
        "return_loan_item",
      );
      expect(template.workflowLaunchers!.find((launcher) => launcher.key === "return_loan_item_scanner")!.workflow).toBe(
        "return_loan_item",
      );
    });

    test(`${locale}: request and edit forms enforce date order while creation fixes asset identity`, () => {
      const { template } = app(locale, "loan_desk");
      for (const key of ["request_loan", "edit_loan"]) {
        expect(template.forms!.find((form) => form.key === key)!.config.validations).toEqual([
          {
            leftFieldId: field("loans.start_date"),
            operator: "lte",
            rightFieldId: field("loans.due_date"),
            errorFieldId: field("loans.due_date"),
            message: expect.any(String),
          },
        ]);
      }
      expect(template.forms!.find((form) => form.key === "add_item")!.config.fields).toEqual(
        expect.arrayContaining([
          { kind: "form_value", fieldId: field("items.quantity"), value: "1" },
          { kind: "form_value", fieldId: field("items.status"), value: ["available"] },
        ]),
      );
    });
  }
});
