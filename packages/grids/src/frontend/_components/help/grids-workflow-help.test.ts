import { describe, expect, test } from "bun:test";
import { compileWorkflow } from "@valentinkolb/cloud/workflows/language";
import { buildWorkflowCatalog } from "../../../service/workflow-catalog";
import { bindGridsWorkflow } from "../../../workflows/binder";
import { GRIDS_WORKFLOW_CHANNELS, GRIDS_WORKFLOW_LAUNCHER_KINDS, GridsWorkflowRunStatusSchema } from "../../../workflows/contracts";
import { gridsWorkflows } from "../../../workflows/module";

const manifest = gridsWorkflows.manifest;

const helpSource = await Bun.file(new URL("../../../help/documents/en/grids-workflows.help.md", import.meta.url)).text();
const cliSkillReference = await Bun.file(new URL("../../../../../../skills/cloud-cli/references/grids.md", import.meta.url)).text();
const workflowReferences = [
  ["help", helpSource],
  ["CLI", cliSkillReference],
] as const;
const controlFlowHelp =
  helpSource.match(/^## Control flow(?: \{[^}\n]*\})?\n([\s\S]*?)\n## Values and references(?: \{[^}\n]*\})?$/m)?.[1] ?? "";

const workflowSnippets = [...helpSource.matchAll(/\*\*([^*\n]+)\*\*\s*\n+```yaml\n([\s\S]*?)```/g)].map(([, title, source]) => ({
  title: title!,
  source: source!.trim(),
}));
const cliWorkflowSnippets = [...cliSkillReference.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1]!.trim());

const manifestTerms = (schema: unknown): string[] => {
  if (!schema || typeof schema !== "object") return [];
  const value = schema as { kind?: unknown; properties?: unknown; enum?: unknown; items?: unknown; variants?: unknown };
  const terms: string[] = [];
  if (value.properties && typeof value.properties === "object") {
    for (const [key, child] of Object.entries(value.properties)) {
      terms.push(key, ...manifestTerms(child));
    }
  }
  if (Array.isArray(value.enum)) terms.push(...value.enum.filter((entry): entry is string => typeof entry === "string"));
  if (value.items) terms.push(...manifestTerms(value.items));
  if (Array.isArray(value.variants)) {
    for (const variant of value.variants) terms.push(...manifestTerms(variant));
  }
  return terms;
};

const ids = {
  items: "11111111-1111-4111-8111-111111111111",
  movements: "22222222-2222-4222-8222-222222222222",
  invoices: "33333333-3333-4333-8333-333333333333",
  itemName: "44444444-4444-4444-8444-444444444444",
  itemStatus: "55555555-5555-4555-8555-555555555555",
  itemReviewedAt: "66666666-6666-4666-8666-666666666666",
  itemLastScannedAt: "77777777-7777-4777-8777-777777777777",
  movementItem: "88888888-8888-4888-8888-888888888888",
  movementType: "99999999-9999-4999-8999-999999999999",
  itemLabel: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  invoiceDocument: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  labelEmail: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  invoiceEmail: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
} as const;

const catalog = buildWorkflowCatalog({
  tables: [
    { id: ids.items, shortId: "items", name: "Items" },
    { id: ids.movements, shortId: "movements", name: "Movements" },
    { id: ids.invoices, shortId: "invoices", name: "Invoices" },
  ],
  fieldsByTable: new Map([
    [
      ids.items,
      [
        { id: ids.itemName, shortId: "name", name: "Name" },
        { id: ids.itemStatus, shortId: "status", name: "Status" },
        { id: ids.itemReviewedAt, shortId: "reviewed_at", name: "Reviewed at" },
        { id: ids.itemLastScannedAt, shortId: "last_scanned_at", name: "Last scanned at" },
      ],
    ],
    [
      ids.movements,
      [
        { id: ids.movementItem, shortId: "item", name: "Item" },
        { id: ids.movementType, shortId: "type", name: "Type" },
      ],
    ],
  ]),
  templates: [
    { id: ids.itemLabel, shortId: "item_label", name: "Item label", tableId: ids.items },
    { id: ids.invoiceDocument, shortId: "invoice", name: "Invoice", tableId: ids.invoices },
  ],
  emailTemplates: [
    { id: ids.labelEmail, shortId: "label_ready", name: "Label ready email" },
    { id: ids.invoiceEmail, shortId: "invoice_email", name: "Invoice email" },
  ],
});

describe("Grids workflow help", () => {
  test("documents the complete manifest vocabulary and limits", () => {
    expect(manifest.triggers.map((trigger) => trigger.kind)).toEqual(["schedule", "recordEvent"]);

    const configTerms = [
      ...manifest.inputs.flatMap((input) => manifestTerms(input.config)),
      ...manifest.triggers.flatMap((trigger) => manifestTerms(trigger.config)),
      ...manifest.actions.flatMap((action) => manifestTerms(action.config)),
    ];

    for (const [label, reference] of workflowReferences) {
      for (const term of [
        ...manifest.inputs.map((input) => input.kind),
        ...manifest.triggers.map((trigger) => trigger.kind),
        ...manifest.actions.map((action) => action.kind),
        ...GRIDS_WORKFLOW_CHANNELS,
        ...GRIDS_WORKFLOW_LAUNCHER_KINDS,
        ...GridsWorkflowRunStatusSchema.options,
        "execute",
        "dryRun",
      ]) {
        expect(reference, `${label} reference missing workflow term ${term}`).toMatch(new RegExp(`\\b${term}\\b`));
      }

      for (const limit of Object.values(manifest.limits ?? {})) {
        expect(reference, `${label} reference missing workflow limit ${limit}`).toContain(limit.toLocaleString("en-US"));
      }

      for (const term of new Set(configTerms)) {
        expect(reference, `${label} reference missing workflow property or enum ${term}`).toMatch(new RegExp(`\\b${term}\\b`));
      }
    }
  });

  test("documents the strict YAML shape and reference rules", () => {
    for (const rootKey of ["inputs", "triggers", "steps"]) {
      expect(helpSource).toContain(`\`${rootKey}\``);
    }
    for (const rule of [
      "exactly one action",
      "Unknown root keys",
      "start with a letter or underscore",
      "case-sensitive",
      "A dynamic value must be the whole",
      "does not perform arithmetic",
      "Reference-only slots stay raw",
    ]) {
      expect(helpSource, `missing workflow language rule: ${rule}`).toContain(rule);
    }
  });

  test("keeps launchers and direct invocation out of YAML triggers", () => {
    for (const legacyTrigger of ["form", "api", "scanner", "bulkSelection"]) {
      expect(helpSource, `legacy YAML trigger ${legacyTrigger}`).not.toContain(`  ${legacyTrigger}:`);
    }

    expect(helpSource).toMatch(/run options\s+are saved separately/);
    expect(helpSource).toContain("outside workflow YAML");
    expect(helpSource).toContain("A workflow does not need a YAML trigger");
  });

  test("compiles and binds every complete workflow snippet", async () => {
    expect(workflowSnippets.length).toBeGreaterThan(0);
    expect(workflowSnippets.length).toBe(helpSource.match(/```yaml/g)?.length ?? 0);
    expect(new Set(workflowSnippets.map(({ title }) => title)).size).toBe(workflowSnippets.length);

    for (const { title, source } of workflowSnippets.filter(({ title }) => !title.endsWith("(fragment)"))) {
      const compiled = await compileWorkflow(source, gridsWorkflows);
      expect(compiled.ok, title).toBe(true);
      if (!compiled.ok) continue;
      expect((await bindGridsWorkflow(compiled.ir, catalog)).ok, title).toBe(true);
    }
  });

  test("keeps every CLI workflow YAML example accepted by the public compiler", async () => {
    expect(cliWorkflowSnippets.length).toBeGreaterThan(0);
    for (const source of cliWorkflowSnippets) {
      const compiled = await compileWorkflow(source, gridsWorkflows);
      expect(compiled.ok, source).toBe(true);
    }
  });

  test("labels partial YAML and documents only supported document generation fields", () => {
    expect(workflowSnippets.filter(({ title }) => title.endsWith("(fragment)")).map(({ title }) => title)).toEqual([
      "Input declarations (fragment)",
    ]);
    expect(helpSource).not.toContain("batch: true");
    expect(helpSource).not.toMatch(/`batch`/);
  });

  test("documents record-event filter syntax and every supported operator", () => {
    for (const term of [
      "fieldId",
      "caseInsensitive",
      "op: AND",
      "op: OR",
      "equals",
      "notEquals",
      "contains",
      "notContains",
      "startsWith",
      "endsWith",
      "regex",
      "=",
      "!=",
      "<",
      "<=",
      ">",
      ">=",
      "between",
      "before",
      "after",
      "onOrBefore",
      "onOrAfter",
      "today",
      "thisWeek",
      "thisMonth",
      "lastNDays",
      "is",
      "isNot",
      "isAnyOf",
      "isNoneOf",
      "containsAny",
      "notContainsAny",
      "isEmpty",
      "isNotEmpty",
    ]) {
      expect(helpSource, `missing record-event filter help for ${term}`).toContain(term);
    }
  });

  test("documents every recursive workflow condition operator", () => {
    for (const operator of ["equals", "notEquals", "contains", "startsWith", "endsWith", "exists", "all", "any", "not"]) {
      expect(controlFlowHelp, `missing workflow condition help for ${operator}`).toContain(`\`${operator}\``);
      expect(cliSkillReference, `CLI reference missing workflow condition ${operator}`).toContain(`\`${operator}\``);
    }
    expect(workflowSnippets.map(({ title }) => title)).toContain("Recursive conditions");
  });
});
