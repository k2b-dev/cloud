import { expect, test } from "bun:test";
import { CustomAppDefinitionSchema } from "../custom-apps/contracts";
import { createObjectListEntry, ObjectListConfigSchema } from "../field-types/object-list";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { createBillingTemplate } from "./billing";
import { billingLineConfig } from "./billing-lines";

const workflowQueries = (value: unknown): string[] => {
  if (!value || typeof value !== "object") return [];
  if ("source" in value && typeof value.source === "string") return [value.source];
  return Object.values(value).flatMap(workflowQueries);
};

for (const locale of ["en", "de"]) {
  test(`billing ${locale} offers defaults without guessing prices or overriding edit dates`, () => {
    const template = createBillingTemplate(locale);
    const row = createObjectListEntry(ObjectListConfigSchema.parse(billingLineConfig(locale)));
    expect(row).toEqual({ Qty001: "1.0000", Unit01: ["C62"], Vat001: ["vat019"] });
    for (const key of ["payment", "refund"]) {
      expect(template.forms?.find((form) => form.key === key)?.config.fields).toContainEqual({
        kind: "user_input",
        fieldId: { $ref: "field", key: "payments.date" },
        width: "compact",
        defaultValue: { kind: "now" },
        helpText: expect.any(String),
      });
    }
    for (const key of ["edit_draft", "edit_self_billing", "edit_correction"]) {
      const entries = template.forms?.find((form) => form.key === key)?.config.fields;
      expect(JSON.stringify(entries)).not.toContain('"defaultValue"');
    }
    const entries = template.forms?.find((form) => form.key === "new_invoice")?.config.fields;
    expect(JSON.stringify(entries)).toContain('"key":"parties.postal_code"');
    const serialized = JSON.stringify(entries);
    for (const key of ["postal_code", "city", "vat_id"]) {
      expect(serialized).toMatch(new RegExp(`"key":"parties\\.${key}"[^}]*}[^}]*"width":"compact"`));
    }
  });
  test(`billing ${locale} row checks project only the fields they need`, () => {
    const queries = createBillingTemplate(locale).workflows?.flatMap((workflow) => workflowQueries(Bun.YAML.parse(workflow.source))) ?? [];
    expect(queries.length).toBeGreaterThan(0);
    for (const source of queries) {
      expect(parseGridsQueryDsl(source).ok).toBe(true);
      if (!/^aggregate /m.test(source)) expect(source).toMatch(/^select /m);
    }
  });

  test(`billing ${locale} app has a conditional setup entry and valid authored queries`, () => {
    const template = createBillingTemplate(locale);
    // Only the issued Document allocates a business number. Draft identity is
    // a random reference, never a second independent invoice sequence.
    expect(template.tables.find((table) => table.key === "bills")?.fields.find((field) => field.key === "reference")?.config).toEqual({
      strategy: "short_code",
      prefix: "REF-",
      length: 8,
    });
    expect(template.tables.some((table) => table.key === "commissions")).toBe(false);
    const newSettlement = template.forms?.find((form) => form.key === "new_self_billing");
    expect(JSON.stringify(newSettlement?.config)).toContain('"key":"bills.positions"');
    expect(template.workflows?.some((workflow) => workflow.key === "prepare_self_billing")).toBe(false);
    expect(template.views?.some((view) => view.key === "settled_items")).toBe(false);
    expect(
      template.tables
        .find((table) => table.key === "bills")
        ?.fields.some((field) => field.key === "commissions" || field.key.startsWith("selected_net")),
    ).toBe(false);
    const settlement = template.workflows?.find((workflow) => workflow.key === "issue_self_billing")!;
    expect(settlement.source).not.toContain("recordList");
    expect(settlement.source.match(/finalizeRecord:/g)).toHaveLength(1);
    expect(settlement.source).toContain("generateDocument:");
    for (const key of ["new_invoice", "new_self_billing", "edit_draft", "edit_self_billing", "edit_correction"]) {
      const config = template.forms?.find((form) => form.key === key)?.config;
      expect(config?.computedFields).toEqual(
        ["net", "tax", "gross"].map((field) => ({ fieldId: { $ref: "field", key: `bills.${field}` }, width: "compact" })),
      );
      const entries = config?.fields;
      expect(JSON.stringify(entries)).toContain('"key":"bills.buyer_reference"');
      if (key.startsWith("new_")) expect(JSON.stringify(entries)).not.toContain('"key":"bills.notes"');
      else expect(JSON.stringify(entries)).toContain('"key":"bills.notes"');
      if (key.startsWith("new_"))
        expect(entries).toContainEqual(
          expect.objectContaining({
            fieldId: { $ref: "field", key: "bills.invoice_date" },
            defaultValue: { kind: "now" },
          }),
        );
      else expect(JSON.stringify(entries)).not.toContain('"kind":"now"');
    }
    expect(template.tables.find((table) => table.key === "bills")?.fields.find((field) => field.key === "positions")).toMatchObject({
      required: true,
      config: { minItems: 1 },
    });
    const refs = new Map<string, string>();
    const add = (kind: string, key: string) => refs.set(`${kind}:${key}`, `R${String(refs.size).padStart(5, "0")}`);
    for (const table of template.tables) {
      add("table", table.key);
      for (const field of table.fields) add("field", `${table.key}.${field.key}`);
    }
    for (const [kind, entries] of [
      ["form", template.forms],
      ["view", template.views],
      ["launcher", template.workflowLaunchers],
      ["documentTemplate", template.documentTemplates],
      ["record", template.records],
    ] as const)
      for (const entry of entries ?? []) add(kind, entry.key);
    const ref = (key: string): string => {
      const id = refs.get(key);
      if (!id) throw new Error(`Unknown authored reference: ${key}`);
      return id;
    };
    const resolve = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(resolve);
      if (!value || typeof value !== "object") return value;
      if ("$ref" in value && "key" in value) return ref(`${value.$ref}:${value.key}`);
      if ("$formula" in value && Array.isArray(value.$formula)) {
        return value.$formula.map((part) => (typeof part === "string" ? part : `{${resolve(part)}}`)).join("");
      }
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key.startsWith("$field:") ? ref(`field:${key.slice(7)}`) : key, resolve(child)]),
      );
    };
    const authored = resolve(template.customApps?.[0]?.definition);
    if (!authored || typeof authored !== "object") throw new Error("Missing billing app");
    const app = CustomAppDefinitionSchema.parse({ ...authored, id: "APP001", baseId: "BASE01" });
    expect(app.startPageId).toBe("invoices");
    const overview = app.pages
      .find((page) => page.id === "invoices")!
      .rows.flatMap((row) => row.columns.flatMap((column) => column.blocks))
      .find((block) => block.id === "bills");
    expect(overview).toMatchObject({ type: "records", workflowStatus: true });
    if (overview?.type !== "records" || overview.source.kind !== "gql") throw new Error("Missing billing overview");
    expect(overview.source.query).not.toContain("finalizationState = 'draft'");
    const invalidStatus = structuredClone(app);
    const invalidList = invalidStatus.pages
      .find((page) => page.id === "invoices")!
      .rows.flatMap((row) => row.columns.flatMap((column) => column.blocks))
      .find((block) => block.id === "bills");
    if (invalidList?.type === "records") delete invalidList.rowNavigate;
    expect(CustomAppDefinitionSchema.safeParse(invalidStatus).success).toBe(false);
    const documentActions = app.pages
      .find((page) => page.id === "bill")!
      .rows.flatMap((row) => row.columns.flatMap((column) => column.blocks))
      .flatMap((block) =>
        block.type === "actions" ? block.actions.filter((action) => action.kind === "workflow" && action.background) : [],
      );
    expect(documentActions).toHaveLength(3);
    for (const action of documentActions) expect(action).toMatchObject({ background: { documentBlockId: "identity" } });

    expect(app.pages).toHaveLength(11);
    expect(app.pages.some((page) => page.id === "issued")).toBe(false);
    const balanceBlocks = app.pages
      .find((page) => page.id === "balances")!
      .rows.flatMap((row) => row.columns.flatMap((column) => column.blocks));
    expect(balanceBlocks.find((block) => block.id === "finalized-help")).toMatchObject({ type: "markdown" });
    for (const id of ["pending-payments", "payments"]) {
      const block = balanceBlocks.find((block) => block.id === id);
      expect(block?.type).toBe("records");
      if (block?.type === "records" && block.source.kind === "gql")
        expect(block.source.query).toContain(`record.finalizationState = '${id === "payments" ? "finalized" : "draft"}'`);
    }
    const paymentBlocks = app.pages
      .find((page) => page.id === "payment")!
      .rows.flatMap((row) => row.columns.flatMap((column) => column.blocks));
    expect(paymentBlocks.some((block) => block.type === "form")).toBe(false);
    expect(paymentBlocks.find((block) => block.id === "actions")?.availableWhen?.query).toContain("record.finalizationState = 'draft'");
    expect(template.tables.find((table) => table.key === "payments")).toMatchObject({
      finalization: { mode: "direct" },
      mutationPolicy: { mode: "selected", sources: ["form", "workflow"] },
    });
    const billBlocks = app.pages.find((page) => page.id === "bill")!.rows.flatMap((row) => row.columns.flatMap((column) => column.blocks));
    expect(billBlocks.some((block) => block.type === "form")).toBe(false);
    expect(billBlocks.find((block) => block.id === "saved")).toMatchObject({ type: "record", editableFieldIds: [] });
    const editPage = app.pages.find((page) => page.id === "bill-details")!;
    expect(editPage.title).toBe(locale === "de" ? "Belegdetails" : "Document details");
    // The neutral page supplies record context; the visible Form title names
    // the current task (editing a draft or recording a payment).
    expect(template.forms?.find((form) => form.key === "payment")?.name).toBe(locale === "de" ? "Zahlung erfassen" : "Record payment");
    expect(editPage.record?.tableId).toBe(ref("table:bills"));
    const editBlocks = editPage.rows.flatMap((row) => row.columns.flatMap((column) => column.blocks));
    const editForms = editBlocks.filter((block) => block.type === "form" && block.mode === "edit");
    expect(editForms).toHaveLength(3);
    for (const block of editForms) {
      if (block.type !== "form") throw new Error("Expected an edit form");
      expect(block.availableWhen?.query).toContain("record.finalizationState = 'draft'");
      expect(block.onSuccessNavigate).toEqual({
        kind: "navigate",
        pageId: "bill",
        params: { bill_id: { source: "RESULT", path: "recordId" } },
      });
    }
    // No editable form can coexist with issuance/retrieval, including
    // recording a payment. Workflow reloads must not discard unsaved inputs.
    for (const page of app.pages) {
      const pageBlocks = page.rows.flatMap((row) => row.columns.flatMap((column) => column.blocks));
      if (!pageBlocks.some((block) => block.type === "form")) continue;
      expect(pageBlocks.some((block) => block.type === "actions" && block.actions.some((action) => action.kind === "workflow"))).toBe(
        false,
      );
      expect(pageBlocks.some((block) => block.type === "record" && block.documents?.preview)).toBe(false);
    }
    const details = app.pages.find((page) => page.id === "bill-details");
    expect(details?.navigation?.visible).toBe(false);
    expect(template.forms?.some((form) => form.key === "bill_details")).toBe(false);
    const drafts = app.pages.find((page) => page.id === "invoices")!;
    const blocks = drafts.rows.flatMap((row) => row.columns.flatMap((column) => column.blocks));
    const setup = blocks.find((block) => block.id === "start-action");
    expect(setup?.type).toBe("actions");
    if (setup?.type !== "actions") throw new Error("Missing setup action");
    expect(setup.actions[0]).toMatchObject({ kind: "navigate", pageId: "settings" });
    expect(setup.availableWhen?.query).toContain(" = false");
    expect(blocks.find((block) => block.id === "start-help")?.availableWhen).toEqual(setup.availableWhen);
    let queries = 0;
    const checkQueries = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if ("availableWhen" in value && value.availableWhen && typeof value.availableWhen === "object" && "query" in value.availableWhen) {
        // Eligibility is an existence check, never a request for every lookup,
        // position and calculated total on the business record.
        expect(value.availableWhen.query).toMatch(/\nselect /);
      }
      if ("query" in value && typeof value.query === "string") {
        expect(parseGridsQueryDsl(value.query).ok, value.query).toBe(true);
        queries++;
      }
      for (const child of Object.values(value)) checkQueries(child);
    };
    checkQueries(app);
    expect(queries).toBeGreaterThan(20);
  });
}
