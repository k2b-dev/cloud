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
        section: { title: expect.any(String) },
      });
    }
    for (const key of ["edit_draft", "edit_self_billing", "edit_correction", "edit_payment"]) {
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
  test(`billing ${locale} exposes essentials and groups optional information without weakening validation`, () => {
    const template = createBillingTemplate(locale);
    const input = (key: string) => template.forms?.find((form) => form.key === key)?.config.fields;
    for (const key of ["new_invoice", "edit_draft", "new_self_billing", "edit_self_billing", "edit_correction"]) {
      expect(input(key)).toContainEqual(
        expect.objectContaining({
          fieldId: { $ref: "field", key: "bills.positions" },
          required: true,
          section: { title: expect.any(String) },
        }),
      );
      expect(input(key)).toContainEqual(expect.objectContaining({ fieldId: { $ref: "field", key: "bills.due_date" }, required: true }));
      expect(input(key)).toContainEqual(expect.objectContaining({ fieldId: { $ref: "field", key: "bills.service_date" }, required: true }));
    }
    for (const key of ["edit_draft", "edit_correction", "edit_self_billing"]) {
      expect(input(key)).toContainEqual(
        expect.objectContaining({
          fieldId: { $ref: "field", key: "bills.notes" },
          section: { title: expect.any(String), collapsible: true },
        }),
      );
    }
    expect(input("partner")).toContainEqual(
      expect.objectContaining({
        fieldId: { $ref: "field", key: "parties.iban" },
        section: { title: expect.any(String), description: expect.any(String), collapsible: true },
      }),
    );
    expect(input("setup")).toBeUndefined();
    expect(template.tables.some((table) => table.key === "settings")).toBe(false);
    expect(JSON.stringify(template.forms)).not.toContain('"key":"bills.original_company"');
    const originalCompany = template.tables
      .find((table) => table.key === "bills")!
      .fields.find((field) => field.key === "original_company")!;
    expect(originalCompany).toMatchObject({ type: "json", hideInTable: true });
    for (const key of ["new_correction", "issue_correction"]) {
      const workflow = template.workflows!.find((workflow) => workflow.key === key)!;
      expect(workflow.source).toContain(`${JSON.stringify(originalCompany.name)}: "\${{ originalDocument.business }}"`);
    }
    expect(JSON.stringify(template)).not.toContain('"key":"bills.settings"');
    const lines = billingLineConfig(locale);
    expect(lines.fields.find((field) => field.id === "Detail")).toMatchObject({ detailsOnly: true, required: false });
    expect(JSON.stringify(input("edit_payment"))).not.toContain("payments.bill");
    expect(JSON.stringify(input("edit_payment"))).not.toContain("payments.refund");
    const billFields = template.tables.find((table) => table.key === "bills")!.fields;
    expect(billFields.find((field) => field.key === "buyer_reference")?.required).toBe(true);
    expect(billFields.find((field) => field.key === "service_date")?.required).not.toBe(true);
    expect(billFields.find((field) => field.key === "service_date")?.defaultValue).toBeUndefined();
    for (const table of template.tables) expect(new Set(table.fields.map((field) => field.name)).size).toBe(table.fields.length);
  });
  test(`billing ${locale} row checks project only the fields they need`, () => {
    const queries = createBillingTemplate(locale).workflows?.flatMap((workflow) => workflowQueries(Bun.YAML.parse(workflow.source))) ?? [];
    expect(queries.length).toBeGreaterThan(0);
    for (const source of queries) {
      expect(parseGridsQueryDsl(source).ok).toBe(true);
      if (!/^aggregate /m.test(source)) expect(source).toMatch(/^select /m);
    }
  });

  test(`billing ${locale} app uses central company settings and valid authored queries`, () => {
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
    expect(overview.source.query).toContain("finalizationState = 'finalized'");
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
    for (const action of documentActions) expect(action).toMatchObject({ variant: "primary", background: { documentBlockId: "identity" } });
    expect(app.pages).toHaveLength(9);
    expect(app.pages.filter((page) => page.navigation?.visible).map((page) => page.id)).toEqual(["invoices", "balances", "partners"]);
    expect(app.sidebar?.actions).toHaveLength(2);
    expect(app.sidebar?.actions.map((action) => action.kind)).toEqual(["form", "form"]);
    expect(app.sidebar?.actions.map((action) => (action.kind === "form" ? action.formId : null))).toEqual([
      ref("form:new_invoice"),
      ref("form:new_self_billing"),
    ]);
    expect(app.pages.some((page) => page.id === "bill-details" || page.id === "payment-edit")).toBe(false);
    const blocksFor = (id: string) =>
      app.pages.find((page) => page.id === id)!.rows.flatMap((row) => row.columns.flatMap((column) => column.blocks));
    const balanceBlocks = blocksFor("balances");
    expect(balanceBlocks.some((block) => block.id === "payments")).toBe(false);
    for (const group of ["overdue", "upcoming", "credits"]) {
      const list = balanceBlocks.find((block) => block.id === group);
      if (list?.type !== "records" || list.source.kind !== "gql") throw new Error("Missing payment work list");
      expect(list.source.query).toContain(group === "credits" ? " < 0" : " > 0");
      if (group !== "credits") expect(list.source.query).toContain(group === "overdue" ? " < TODAY()" : " >= TODAY()");
      expect(list.rowNavigate?.pageId).toBe(group === "credits" ? "bill" : "payment-new");
      expect(list.source.query).toContain(ref("field:bills.due_date"));
    }
    expect(blocksFor("bill").find((block) => block.id === "reuse")?.availableWhen?.query).toContain("finalizationState = 'finalized'");
    expect(blocksFor("bill").find((block) => block.id === "reuse")).toMatchObject({
      actions: [{ kind: "workflow", launcherId: ref("launcher:reuse_invoice"), onSuccessNavigate: { pageId: "bill" } }],
    });
    const pending = balanceBlocks.find((block) => block.id === "pending-payments");
    expect(pending).toMatchObject({
      type: "records",
      rowActions: [
        { id: "confirm", variant: "primary" },
        { id: "discard", variant: "danger" },
      ],
    });
    const paymentBlocks = blocksFor("payment");
    expect(paymentBlocks.find((block) => block.id === "edit")).toMatchObject({
      type: "form",
      formId: ref("form:edit_payment"),
      actionsBlockId: "actions",
    });
    expect(paymentBlocks.find((block) => block.id === "payment-context")).toMatchObject({
      type: "record",
      fieldIds: [ref("field:payments.bill"), ref("field:payments.refund")],
      editableFieldIds: [],
    });
    expect(paymentBlocks.find((block) => block.id === "actions")?.availableWhen?.query).toContain("record.finalizationState = 'draft'");
    expect(paymentBlocks.find((block) => block.id === "back")).toMatchObject({
      type: "actions",
      actions: [{ params: { bill_id: { source: "RECORD", path: "relation", fieldId: ref("field:payments.bill") } } }],
    });
    expect(template.tables.find((table) => table.key === "payments")).toMatchObject({
      finalization: { mode: "direct" },
      mutationPolicy: { mode: "selected", sources: ["form", "workflow"] },
    });
    const billBlocks = blocksFor("bill");
    expect(billBlocks.find((block) => block.id === "identity")).toMatchObject({
      type: "record",
      heading: { fieldId: ref("field:bills.party_name"), documentNumber: true },
    });
    expect(billBlocks.find((block) => block.id === "identity")?.availableWhen).toBeUndefined();
    const forms = billBlocks.filter((block) => block.type === "form");
    expect(forms).toHaveLength(3);
    for (const block of forms) {
      expect(block.availableWhen?.query).toContain("record.finalizationState = 'draft'");
      expect(block.actionsBlockId).toBeTruthy();
      const actions = billBlocks.find((candidate) => candidate.id === block.actionsBlockId);
      expect(actions?.availableWhen?.query).not.toContain("record.finalizationState");
      if (actions?.type === "actions")
        expect(actions.actions.find((action) => action.id === "discard")?.availableWhen?.query).toContain(
          "record.finalizationState = 'draft'",
        );
      expect(actions).toMatchObject({
        type: "actions",
        actions: [{ variant: "primary" }, { id: "discard", variant: "danger", onSuccessNavigate: { pageId: "invoices" } }],
      });
    }
    const metrics = billBlocks.find((block) => block.id === "balance");
    if (metrics?.type !== "metrics" || metrics.source.kind !== "gql") throw new Error("Missing numeric balance summary");
    expect(metrics.source.query).not.toContain(ref("field:bills.party_name"));
    expect(metrics.source.query).not.toContain(ref("field:bills.due_date"));
    expect(metrics.source.query).toContain("@params.bill_id");
    expect(metrics.source.query).toContain("\nlimit 1");
    expect(metrics.source.query).not.toContain("\naggregate ");
    for (const id of ["payments", "pending-payments"])
      expect(billBlocks.find((block) => block.id === id)?.availableWhen?.query).toContain("record.finalizationState = 'finalized'");
    for (const id of ["payment-new", "refund-new"]) {
      const page = app.pages.find((page) => page.id === id)!;
      expect(page.title).toBe(
        id === "payment-new"
          ? locale === "de"
            ? "Zahlung erfassen"
            : "Record payment"
          : locale === "de"
            ? "Erstattung erfassen"
            : "Record refund",
      );
      expect(blocksFor(id).find((block) => block.type === "form")).toMatchObject({
        onSuccessNavigate: { pageId: "bill", params: { bill_id: { source: "PARAMS", path: "bill_id" } } },
      });
    }
    expect(billBlocks.find((block) => block.id === "other-actions")).toMatchObject({
      type: "actions",
      actions: [
        { id: "new-correction", onSuccessNavigate: { pageId: "bill", params: { bill_id: { source: "RESULT", path: "recordId" } } } },
        { id: "refund" },
      ],
    });
    expect(app.pages.some((page) => page.id === "settings" || page.id === "self-billing-new")).toBe(false);
    expect(blocksFor("invoices").find((block) => block.id === "start-help")?.availableWhen).toBeUndefined();
    // Saving refreshes the same workspace so editing stays available and all
    // headings, saved values and computed totals reflect the committed version.
    for (const page of app.pages) {
      for (const block of blocksFor(page.id)) {
        if (block.type !== "form" || block.mode !== "edit") continue;
        expect(block.onSuccessNavigate).toEqual({
          kind: "navigate",
          pageId: page.id,
          params: Object.fromEntries(Object.keys(page.parameters).map((key) => [key, { source: "PARAMS", path: key }])),
        });
      }
    }
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
