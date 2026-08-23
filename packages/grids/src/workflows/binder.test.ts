import { describe, expect, test } from "bun:test";
import { compileWorkflow } from "@valentinkolb/cloud/workflows/language";
import { buildWorkflowCatalog, type WorkflowCatalog } from "../service/workflow-catalog";
import { bindGridsWorkflow, canonicalizeGridsWorkflowSourceForMigration, compileAndBindGridsWorkflowSource } from "./binder";
import { gridsWorkflows } from "./module";

const ids = {
  items: "11111111-1111-4111-8111-111111111111",
  archive: "22222222-2222-4222-8222-222222222222",
  name: "33333333-3333-4333-8333-333333333333",
  status: "44444444-4444-4444-8444-444444444444",
  archivedName: "55555555-5555-4555-8555-555555555555",
  document: "66666666-6666-4666-8666-666666666666",
  email: "77777777-7777-4777-8777-777777777777",
  current: "88888888-8888-4888-8888-888888888888",
  related: "99999999-9999-4999-8999-999999999999",
  corrects: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
} as const;

const catalog = (): WorkflowCatalog =>
  buildWorkflowCatalog({
    tables: [
      { id: ids.items, shortId: "TBL001", name: "Items" },
      { id: ids.archive, shortId: "TBL002", name: "Archive" },
    ],
    fieldsByTable: new Map([
      [
        ids.items,
        [
          { id: ids.name, shortId: "FLD001", name: "Name" },
          { id: ids.status, shortId: "FLD002", name: "Status" },
          {
            id: ids.current,
            shortId: "FLD003",
            name: "Current archive",
            relation: { targetTableId: ids.archive, cardinality: "single" },
          },
          {
            id: ids.related,
            shortId: "FLD004",
            name: "Related archives",
            relation: { targetTableId: ids.archive, cardinality: "multiple" },
          },
          {
            id: ids.corrects,
            shortId: "FLD006",
            name: "Corrects",
            relation: { targetTableId: ids.items, cardinality: "single" },
          },
        ],
      ],
      [ids.archive, [{ id: ids.archivedName, shortId: "FLD005", name: "Name" }]],
    ]),
    templates: [{ id: ids.document, shortId: "DOC001", name: "Item sheet", tableId: ids.items }],
    emailTemplates: [{ id: ids.email, shortId: "EML001", name: "Ready notice" }],
  });

const compile = async (source: string) => {
  const result = await compileWorkflow(source, gridsWorkflows);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  return result.ir;
};

describe("Grids workflow binder", () => {
  test("binds a Close selection profile to one stable Table", async () => {
    const result = await compileAndBindGridsWorkflowSource(
      `inputs:
  records:
    type: recordList
    table: TBL001
    required: true
steps:
  - forEach: inputs.records
    as: record
    do:
      - closeRecord:
          record: record
`,
      catalog(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.bindings["inputs.records.table"]).toBe(ids.items);
    expect(result.plan.steps[0]).toMatchObject({ kind: "forEach", alias: "record" });
  });

  test("binds a correction Draft to its existing type and self-relation fields", async () => {
    const result = await compileAndBindGridsWorkflowSource(
      `inputs:
  original:
    type: record
    table: TBL001
    required: true
steps:
  - createCorrectionDraft:
      original: inputs.original
      typeField: FLD002
      typeValue: correction
      originalField: FLD006
      copyFields:
        - FLD001
`,
      catalog(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.bindings).toMatchObject({
      "inputs.original.table": ids.items,
      "steps.0.createCorrectionDraft.typeField": ids.status,
      "steps.0.createCorrectionDraft.originalField": ids.corrects,
      "steps.0.createCorrectionDraft.copyFields.0": ids.name,
    });
  });

  test("rejects two correction prefill aliases for the same field", async () => {
    const result = await compileAndBindGridsWorkflowSource(
      `inputs:
  original:
    type: record
    table: TBL001
    required: true
steps:
  - createCorrectionDraft:
      original: inputs.original
      typeField: FLD002
      typeValue: correction
      originalField: FLD006
      copyFields:
        - Name
        - FLD001
`,
      catalog(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "binding.duplicate", path: ["steps", 0, "createCorrectionDraft", "copyFields", 1] }),
    );
  });

  test("rejects private UUID references and canonicalizes author references to public IDs", async () => {
    const source = `inputs:
  item:
    type: record
    table: Items
steps:
  - updateRecord:
      record: inputs.item
      set:
        Status: "\${{ inputs.item.Name }}"
`;
    const result = await compileAndBindGridsWorkflowSource(source, catalog());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toContain("table: TBL001");
    expect(result.source).toContain("FLD002:");
    expect(result.source).toContain("inputs.item.FLD001");
    expect(result.source).not.toContain("table: Items");
    expect(result.source).not.toContain("Status:");
    const canonical = await compile(result.source ?? "");
    expect(result.plan.sourceHash).toBe(canonical.sourceHash);

    const privateSource = source.replace("table: Items", `table: ${ids.items}`);
    const rejected = await bindGridsWorkflow(await compile(privateSource), catalog(), privateSource);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.diagnostics[0]?.code).toBe("binding.unknown");
  });

  test("canonicalizes a relation field without corrupting its recordId suffix", async () => {
    const result = await compileAndBindGridsWorkflowSource(
      `inputs:
  item:
    type: record
    table: Items
steps:
  - succeed:
      message: "Archive: \${{ inputs.item.Current archive.recordId }}"
`,
      catalog(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toContain("inputs.item.FLD003.recordId");
    expect(result.source).not.toContain("Current archive.recoFLD003");
  });

  test("migrates only binder-known legacy references", async () => {
    const literalUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const source = `inputs:
  item:
    type: record
    table: ${ids.items}
steps:
  - succeed:
      message: ${literalUuid}
`;
    const result = await canonicalizeGridsWorkflowSourceForMigration(source, catalog(), new Map([[ids.items, [ids.items, "old-items"]]]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toContain("table: TBL001");
    expect(result.source).toContain(literalUuid);
  });

  test("accepts the commented record-event trigger", async () => {
    const ir = await compile(`inputs:
  item:
    type: record
    table: Items
    required: true
triggers:
  recordEvent:
    event: commented
    table: Items
    with:
      item: "\${{ trigger.record }}"
steps:
  - succeed:
      message: Comment received
`);
    const result = await bindGridsWorkflow(ir, catalog());
    expect(result.ok).toBe(true);
  });

  test("binds human-readable resources and fields to stable path-keyed IDs", async () => {
    const source = `inputs:
  item:
    type: record
    table: Items
    required: true
  items:
    type: recordList
    table: Items
triggers:
  recordEvent:
    event: updated
    filter:
      fieldId: Status
      op: equals
      value: Ready
    with:
      item: "\${{ trigger.record }}"
steps:
  - forEach: inputs.items
    as: item
    do:
      - updateRecord:
          record: item
          set:
            Status: Ready
      - generateDocument:
          template: Item sheet
          record: item
          saveAs: sheet
      - createDocumentLink:
          document: sheet
          saveAs: link
      - sendEmail:
          template: Ready notice
          to:
            - email: "\${{ item.Name }}"
          data:
            filename: "\${{ sheet.filename }}"
`;
    const ir = await compile(source);
    const result = await bindGridsWorkflow(ir, catalog());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.bindings).toEqual({
      "inputs.item.table": ids.items,
      "inputs.items.table": ids.items,
      "steps.0.do.0.updateRecord.set.Status": ids.status,
      "steps.0.do.1.generateDocument.template": ids.document,
      "steps.0.do.3.sendEmail.template": ids.email,
      "steps.0.do.3.sendEmail.to.0.email": ids.name,
      "triggers.recordEvent.filter.fieldId": ids.status,
      "triggers.recordEvent.table": ids.items,
    });
    expect(result.plan.catalogHash).toHaveLength(64);
    expect(result.plan.manifestHash).toHaveLength(64);
    expect(await bindGridsWorkflow(ir, catalog())).toEqual(result);
  });

  test("binds every table and field used by an atomic record change", async () => {
    const source = `inputs:
  item:
    type: record
    table: Items
    required: true
steps:
  - atomicRecords:
      locks:
        - inputs.item
      checks:
        - table: Items
          where:
            - field: Status
              op: equals
              value: Ready
          assert: notEmpty
      changes:
        - updateRecord:
            record: inputs.item
            set:
              Status: Reserved
        - createRecord:
            table: Archive
            values:
              Name: "\${{ inputs.item.Name }}"
`;
    const result = await bindGridsWorkflow(await compile(source), catalog());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.bindings).toEqual({
      "inputs.item.table": ids.items,
      "steps.0.atomicRecords.changes.0.updateRecord.set.Status.$target": ids.status,
      "steps.0.atomicRecords.changes.1.createRecord.table": ids.archive,
      "steps.0.atomicRecords.changes.1.createRecord.values.Name": ids.name,
      "steps.0.atomicRecords.changes.1.createRecord.values.Name.$target": ids.archivedName,
      "steps.0.atomicRecords.checks.0.table": ids.items,
      "steps.0.atomicRecords.checks.0.where.0.field": ids.status,
    });
  });

  test("types relation fields as record references in existing workflow slots", async () => {
    const source = `inputs:
  item:
    type: record
    table: Items
    required: true
steps:
  - updateRecord:
      record: inputs.item.Current archive
      set:
        Name: Current
  - if:
      equals:
        - "\${{ inputs.item.Current archive.recordId }}"
        - expected
    then:
      - succeed:
          message: Relation id resolved
  - forEach: inputs.item.Related archives
    as: archive
    do:
      - updateRecord:
          record: archive
          set:
            Name: Related
`;
    const result = await bindGridsWorkflow(await compile(source), catalog());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.bindings).toEqual({
      "inputs.item.table": ids.items,
      "steps.0.updateRecord.record": ids.current,
      "steps.0.updateRecord.record.$relationCardinality": "single",
      "steps.0.updateRecord.record.$relationTarget": ids.archive,
      "steps.0.updateRecord.set.Name": ids.archivedName,
      "steps.1.if.equals.0": ids.current,
      "steps.1.if.equals.0.$relationCardinality": "single",
      "steps.1.if.equals.0.$relationTarget": ids.archive,
      "steps.2.do.0.updateRecord.set.Name": ids.archivedName,
      "steps.2.forEach": ids.related,
      "steps.2.forEach.$relationCardinality": "multiple",
      "steps.2.forEach.$relationTarget": ids.archive,
    });
  });

  test("reports permission-filtered and ambiguous catalog misses at source locations", async () => {
    const source = `inputs:
  item:
    type: record
    table: Hidden
steps:
  - sendEmail:
      template: Notice
      to:
        - email: user@example.test
`;
    const visible = buildWorkflowCatalog({
      tables: [],
      emailTemplates: [
        { id: ids.email, shortId: "first", name: "Notice" },
        { id: "88888888-8888-4888-8888-888888888888", shortId: "second", name: "Notice" },
      ],
    });
    const result = await bindGridsWorkflow(await compile(source), visible);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: "binding.unknown", path: ["inputs", "item", "table"] },
      { code: "binding.ambiguous", path: ["steps", 0, "sendEmail", "template"] },
    ]);
    expect(result.diagnostics[0]?.message).toContain("Unknown or inaccessible table");
    expect(result.diagnostics[0]?.location).toEqual({ offset: source.indexOf("table: Hidden"), line: 4, column: 5 });
    expect(result.diagnostics[1]?.location).toEqual({ offset: source.indexOf("template: Notice"), line: 7, column: 7 });
  });

  test("validates reference types, lexical scopes, saveAs, and forEach", async () => {
    const source = `inputs:
  item:
    type: record
    table: Items
steps:
  - generateDocument:
      template: Item sheet
      record: inputs.item
      saveAs: output
  - createDocumentLink:
      document: inputs.item
      saveAs: output
  - forEach: inputs.item
    as: row
    do:
      - setVariable:
          name: inside
          value: "\${{ row.Name }}"
  - setVariable:
      name: after
      value: "\${{ row.Name }}"
`;
    const result = await bindGridsWorkflow(await compile(source), catalog());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(({ code, path }) => ({ code, path }))).toEqual(
      expect.arrayContaining([
        { code: "reference.type", path: ["steps", 1, "createDocumentLink", "document"] },
        { code: "scope.duplicate", path: ["steps", 1, "createDocumentLink", "saveAs"] },
        { code: "reference.type", path: ["steps", 2, "forEach"] },
        { code: "reference.unknown", path: ["steps", 3, "setVariable", "value"] },
      ]),
    );
  });

  test("validates trigger with completeness, event types, and record table scope", async () => {
    const source = `inputs:
  item:
    type: record
    table: Archive
    required: true
  count:
    type: number
    required: true
  echo:
    type: text
triggers:
  recordEvent:
    event: updated
    table: Items
    with:
      item: "\${{ trigger.record }}"
      count: "\${{ trigger.occurredAt }}"
      echo: "\${{ inputs.echo }}"
steps:
  - succeed:
      message: done
`;
    const result = await bindGridsWorkflow(await compile(source), catalog());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(({ code, path }) => ({ code, path }))).toEqual(
      expect.arrayContaining([
        { code: "binding.scope", path: ["triggers", "recordEvent", "with", "item"] },
        { code: "trigger.type", path: ["triggers", "recordEvent", "with", "count"] },
        { code: "reference.scope", path: ["triggers", "recordEvent", "with", "echo"] },
      ]),
    );

    const missingSource = source.replace('      count: "${{ trigger.occurredAt }}"\n', "");
    const missing = await bindGridsWorkflow(await compile(missingSource), catalog());
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.diagnostics).toContainEqual(
        expect.objectContaining({ code: "trigger.required", path: ["triggers", "recordEvent", "with", "count"] }),
      );
    }
  });

  test("rejects unavailable record-event values instead of guessing", async () => {
    const result = await bindGridsWorkflow(
      await compile(`inputs:
  item:
    type: record
    table: Items
    required: true
triggers:
  recordEvent:
    event: updated
    table: Items
    with:
      item: "\${{ trigger.before }}"
steps:
  - succeed:
      message: done
`),
      catalog(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: "reference.unknown", path: ["triggers", "recordEvent", "with", "item"] }),
      );
    }
  });

  test("rejects fields and document templates from a different table", async () => {
    const source = `inputs:
  archived:
    type: record
    table: Archive
steps:
  - updateRecord:
      record: inputs.archived
      set:
        Status: Ready
  - generateDocument:
      template: Item sheet
      record: inputs.archived
`;
    const result = await bindGridsWorkflow(await compile(source), catalog());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: "binding.unknown", path: ["steps", 0, "updateRecord", "set", "Status"] },
      { code: "binding.scope", path: ["steps", 1, "generateDocument", "record"] },
    ]);
  });

  test("supports now in trigger bindings and requires raw syntax in dedicated reference slots", async () => {
    const schedule = await bindGridsWorkflow(
      await compile(`inputs:
  at:
    type: dateTime
    required: true
triggers:
  schedule:
    cron: "0 8 * * *"
    with:
      at: "\${{ now() }}"
steps:
  - succeed:
      message: done
`),
      catalog(),
    );
    expect(schedule.ok).toBe(true);

    const wrapped = await bindGridsWorkflow(
      await compile(`inputs:
  item:
    type: record
    table: Items
steps:
  - updateRecord:
      record: "\${{ inputs.item }}"
      set:
        Status: Ready
`),
      catalog(),
    );
    expect(wrapped.ok).toBe(false);
    if (!wrapped.ok) {
      expect(wrapped.diagnostics).toContainEqual(
        expect.objectContaining({ code: "reference.invalid", path: ["steps", 0, "updateRecord", "record"] }),
      );
    }
  });

  test.each([
    ["61 8 * * *", "UTC", "cron minute field is invalid"],
    ["0 8 * * *", "Mars/Olympus", "timezone must be an IANA timezone"],
  ])("rejects invalid schedules during binding", async (cron, timezone, message) => {
    const result = await bindGridsWorkflow(
      await compile(`triggers:
  schedule:
    cron: "${cron}"
    timezone: ${timezone}
steps:
  - succeed:
      message: done
`),
      catalog(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: "schedule.invalid", message: expect.stringContaining(message), path: ["triggers", "schedule"] }),
      );
    }
  });

  test("binds recursive conditions and validates text operand types", async () => {
    const result = await bindGridsWorkflow(
      await compile(`inputs:
  item:
    type: record
    table: Items
  items:
    type: recordList
    table: Items
  label:
    type: text
  count:
    type: number
steps:
  - if:
      all:
        - contains: ["\${{ inputs.item.Name }}", "\${{ inputs.label }}"]
        - contains: ["known-record-id", "\${{ inputs.item.recordId }}"]
        - not:
            any:
              - startsWith: ["\${{ inputs.count }}", "1"]
              - exists: inputs.item.Status
        - endsWith: [null, "suffix"]
        - includes: ["\${{ inputs.items }}", "\${{ inputs.count }}"]
    then:
      - succeed:
          message: matched
`),
      catalog(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "condition.type",
        path: ["steps", 0, "if", "all", 2, "not", "any", 0, "startsWith", 0],
      }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "condition.type", path: ["steps", 0, "if", "all", 3, "endsWith", 0] }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "condition.type", path: ["steps", 0, "if", "all", 4, "includes", 1] }),
    );
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: "reference.unknown" }));
  });

  test("reserves runtime roots for variables, action outputs, and loop aliases", async () => {
    const result = await bindGridsWorkflow(
      await compile(`inputs:
  item:
    type: record
    table: Items
  items:
    type: recordList
    table: Items
steps:
  - setVariable: { name: bindings, value: one }
  - setVariable: { name: inputs, value: two }
  - generateDocument:
      template: Item sheet
      record: inputs.item
      saveAs: context
  - forEach: inputs.items
    as: trigger
    do:
      - succeed: { message: unreachable }
`),
      catalog(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map(({ code, path }) => ({ code, path }))).toEqual(
        expect.arrayContaining([
          { code: "scope.duplicate", path: ["steps", 0, "setVariable", "name"] },
          { code: "scope.duplicate", path: ["steps", 1, "setVariable", "name"] },
          { code: "scope.duplicate", path: ["steps", 2, "generateDocument", "saveAs"] },
          { code: "scope.duplicate", path: ["steps", 3, "as"] },
        ]),
      );
    }
  });

  test("accepts complete structured and literal value paths", async () => {
    const result = await bindGridsWorkflow(
      await compile(`inputs:
  item:
    type: record
    table: Items
  items:
    type: recordList
    table: Items
steps:
  - updateRecord:
      record: inputs.items.0
      set: { Status: Ready }
  - generateDocument:
      template: Item sheet
      record: inputs.item
      saveAs: sheet
  - setVariable: { name: tag, value: "\${{ sheet.tags.0 }}" }
  - setVariable: { name: author, value: "\${{ sheet.createdBy }}" }
  - setVariable: { name: created, value: "\${{ sheet.createdAt }}" }
  - createDocumentLink:
      document: sheet
      saveAs: link
  - setVariable: { name: url, value: "\${{ link.url }}" }
  - sendEmail:
      template: Ready notice
      to: [{ email: user@example.test }]
      saveAs: delivery
  - setVariable: { name: status, value: "\${{ delivery.recipients.0.status }}" }
  - setVariable:
      name: payload
      value: { rows: [{ name: Ada }] }
  - setVariable: { name: nested, value: "\${{ payload.rows.0.name }}" }
`),
      catalog(),
    );

    expect(result.ok).toBe(true);
  });

  test("rejects invalid structured and literal value-path continuations", async () => {
    const result = await bindGridsWorkflow(
      await compile(`inputs:
  item:
    type: record
    table: Items
steps:
  - generateDocument:
      template: Item sheet
      record: inputs.item
      saveAs: sheet
  - setVariable: { name: badTag, value: "\${{ sheet.tags.name }}" }
  - setVariable: { name: badFilename, value: "\${{ sheet.filename.extra }}" }
  - setVariable: { name: removedGeneratedAt, value: "\${{ sheet.generatedAt }}" }
  - sendEmail:
      template: Ready notice
      to: [{ email: user@example.test }]
      saveAs: delivery
  - setVariable: { name: badRecipient, value: "\${{ delivery.recipients.status }}" }
  - setVariable:
      name: payload
      value: { rows: [{ name: Ada }] }
  - setVariable: { name: badLiteral, value: "\${{ payload.rows.01.name }}" }
`),
      catalog(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map(({ code, path }) => ({ code, path }))).toEqual([
        { code: "reference.path", path: ["steps", 1, "setVariable", "value"] },
        { code: "reference.path", path: ["steps", 2, "setVariable", "value"] },
        { code: "reference.path", path: ["steps", 3, "setVariable", "value"] },
        { code: "reference.path", path: ["steps", 5, "setVariable", "value"] },
        { code: "reference.path", path: ["steps", 7, "setVariable", "value"] },
      ]);
    }
  });
});
