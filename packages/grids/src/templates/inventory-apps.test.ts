import { describe, expect, test } from "bun:test";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { createInventoryTemplate } from "./inventory";
import { field, form, launcher } from "./types";

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
    test(`${locale}: every authored app query parses after localized references resolve`, () => {
      const template = createInventoryTemplate(locale);
      const names = new Map<string, string>();
      for (const table of template.tables) {
        names.set(`table:${table.key}`, table.name);
        for (const field of table.fields) names.set(`field:${table.key}.${field.key}`, field.name);
      }
      const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        if ("$formula" in value && Array.isArray(value.$formula)) {
          const source = value.$formula
            .map((part: unknown) => {
              if (typeof part === "string") return part;
              if (!part || typeof part !== "object" || !("$ref" in part) || !("key" in part))
                throw new Error("Invalid template formula reference");
              const name = names.get(`${part.$ref}:${part.key}`);
              if (!name) throw new Error("Missing template formula name");
              return JSON.stringify(name);
            })
            .join("");
          const result = parseGridsQueryDsl(source);
          if (!result.ok) throw new Error(`${source}\n${JSON.stringify(result.diagnostics)}`);
          expect(result.ok).toBe(true);
          return;
        }
        for (const child of Object.values(value)) visit(child);
      };
      visit(template.customApps);
    });
    test(`${locale}: borrowers combine filtered kits and items while private loan details remain actor-scoped`, () => {
      const { template, definition, pages } = app(locale, "equipment_loans");
      expect(definition.sidebar?.actions).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "new-loan", formId: form("request_loan"), fixedValues: {} })]),
      );
      expect(template.forms!.find((form) => form.key === "request_loan")!.isPublic).toBe(false);
      const kit = pages.find((page) => page.id === "kit")!;
      expect(JSON.stringify(kit.availableWhen)).toContain("kits.requestable");
      expect(JSON.stringify(kit.availableWhen)).toContain("kits.status");
      expect(blocks(kit).find((block) => block.id === "request")).toMatchObject({
        formId: form("request_loan"),
        fixedValues: {},
        presentation: { kind: "dialog" },
      });
      const request = template.forms!.find((form) => form.key === "request_loan")!;
      expect(request.config.fields).toEqual(
        expect.arrayContaining([
          ...[
            ["kits", "kits"],
            ["requested_items", "items"],
          ].map(([key, target]) =>
            expect.objectContaining({
              kind: "user_input",
              fieldId: field(`loans.${key}`),
              relationFilter: {
                op: "AND",
                filters: [
                  { fieldId: field(`${target}.requestable`), op: "=", value: true },
                  { fieldId: field(`${target}.status`), op: "is", value: "available" },
                ],
              },
            }),
          ),
        ]),
      );
      expect(request.config.validations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operator: "anyPresent",
            leftFieldId: field("loans.kits"),
            rightFieldId: field("loans.requested_items"),
          }),
        ]),
      );
      expect(template.tables.find((table) => table.key === "loans")!.fields.find((field) => field.key === "kits")!.required).not.toBe(true);
      expect(
        template.tables.find((table) => table.key === "items")!.fields.find((field) => field.key === "requestable")!.defaultValue,
      ).toBe(false);
      expect(template.forms!.find((form) => form.key === "edit_item")!.config.fields).toEqual(
        expect.arrayContaining([expect.objectContaining({ fieldId: field("items.requestable") })]),
      );
      const loan = pages.find((page) => page.id === "loan")!;
      expect(blocks(loan).find((block) => block.id === "requested-equipment")).toMatchObject({
        fieldIds: [field("loans.kits"), field("loans.requested_items"), field("loans.purpose")],
      });
      expect(blocks(loan).find((block) => block.id === "assigned-equipment")).toBeDefined();
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
      expect(blocks(borrower).find((block) => block.id === "documents")).toMatchObject({ documents: { templateIds: expect.any(Array) } });
      expect(JSON.stringify(blocks(borrower).find((block) => block.id === "documents"))).not.toContain('"preview":true');
      expect(JSON.stringify(blocks(borrower).find((block) => block.id === "documents"))).toContain("'sent'");
      expect(blocks(borrower).filter((block) => String(block.id).startsWith("status-"))).toHaveLength(6);
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
        expect(template.forms!.find((form) => form.key === key)!.config.validations).toEqual(
          expect.arrayContaining([
            {
              leftFieldId: field("loans.start_date"),
              operator: "lte",
              rightFieldId: field("loans.due_date"),
              errorFieldId: field("loans.due_date"),
              message: expect.any(String),
            },
          ]),
        );
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
