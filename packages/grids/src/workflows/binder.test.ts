import { describe, expect, test } from "bun:test";
import { compileWorkflow } from "@k2b/cloud/workflows/language";
import { ok } from "@k2b/stdlib";
import {
  buildWorkflowCatalog,
  restoreWorkflowCatalog,
  snapshotWorkflowCatalog,
  type WorkflowCatalog,
  WorkflowCatalogSnapshotSchema,
} from "../service/workflow-catalog";
import { bindGridsWorkflow, compileAndBindGridsWorkflowSource } from "./binder";
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
  combined: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as const;

const catalog = (): WorkflowCatalog =>
  buildWorkflowCatalog({
    tables: [
      { id: ids.items, shortId: "TBL001", name: "Items", kind: "stored" },
      { id: ids.archive, shortId: "TBL002", name: "Archive", kind: "stored" },
      { id: ids.combined, shortId: "TBL003", name: "Overview", kind: "federated" },
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
  test("rejects non-row associatedData at publication", async () => {
    for (const source of ["from table Items\nselect Name", "from table Items\naggregate count(*) as total"]) {
      const result = await compileAndBindGridsWorkflowSource(
        `steps:\n  - query:\n      source: |\n        ${source.replaceAll("\n", "\n        ")}\n      saveAs: report\n  - generateDocument:\n      data: report\n      associatedData: report\n      output: { kind: json }\n`,
        catalog(),
        async () => ok({ source, schemaHash: "a".repeat(64) }),
      );
      expect(result.ok).toBe(!source.includes("aggregate"));
      if (!result.ok) expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes("single-table row query"))).toBe(true);
    }
  });
  test("binds document snapshot sources with literal paths", async () => {
    const source = `steps:
  - generateDocument:
      data:
        documents: [DOC001]
        columns: [{ key: number, type: text, path: [number] }]
      output: { kind: json }
`;
    expect((await compileAndBindGridsWorkflowSource(source, catalog())).ok).toBe(true);
    expect((await compileAndBindGridsWorkflowSource(source.replace("[number]", '["${{ inputs.path }}"]'), catalog())).ok).toBe(false);
    const recordSource = source
      .replace("documents: [DOC001]", "snapshots: [SNP001]")
      .replace("path: [number]", "path: [root, data, FLD001]");
    expect((await compileAndBindGridsWorkflowSource(recordSource, catalog())).ok).toBe(true);
    expect(
      (await compileAndBindGridsWorkflowSource(recordSource.replace("[root, data, FLD001]", '["${{ inputs.path }}"]'), catalog())).ok,
    ).toBe(false);
    expect(
      (
        await compileAndBindGridsWorkflowSource(
          recordSource.replace("snapshots: [SNP001]", "snapshots: [SNP001]\n        documents: [DOC001]"),
          catalog(),
        )
      ).ok,
    ).toBe(false);
  });

  test("document expression fields match the actual small action result", async () => {
    const source = `steps:
  - generateDocument:
      data: { columns: [{ key: amount, type: decimal }], rows: [{ amount: "1.00" }] }
      output: { kind: json }
      saveAs: issued
  - generateDocument:
      data: { columns: [{ key: value, type: text }], rows: [{ value: "\${{ issued.number }}" }] }
      output: { kind: json }
`;
    for (const field of ["number", "shortId", "primaryArtifactKey"])
      expect((await compileAndBindGridsWorkflowSource(source.replace("issued.number", `issued.${field}`), catalog())).ok).toBe(true);
    for (const field of ["documentNumber", "snapshotId", "workflowRunId"])
      expect((await compileAndBindGridsWorkflowSource(source.replace("issued.number", `issued.${field}`), catalog())).ok).toBe(false);
  });
  test("binds typed inline data and rejects dynamic column definitions and unknown inputs", async () => {
    const source = `inputs:
  amount:
    type: text
steps:
  - generateDocument:
      data:
        columns: [{ key: amount, type: decimal }]
        rows: [{ amount: "\${{ inputs.amount }}" }]
      output: { kind: json }
`;
    const bind = (yaml: string) => compileAndBindGridsWorkflowSource(yaml, catalog());
    expect((await bind(source)).ok).toBe(true);
    expect((await bind(source.replace("inputs.amount", "inputs.missing"))).ok).toBe(false);
    expect((await bind(source.replace("key: amount", 'key: "${{ inputs.amount }}"'))).ok).toBe(false);
    expect((await bind(source.replace("type: decimal", "type: imaginary"))).ok).toBe(false);
  });
  test("binds typed JSON wrapper values and rejects dynamic structural names", async () => {
    const source = `inputs:
  approved:
    type: boolean
steps:
  - query:
      source: from table Items select Name
      saveAs: report
  - generateDocument:
      data: report
      output:
        kind: json
        wrapper:
          rowsKey: items
          values:
            approved: "\${{ inputs.approved }}"
            source: Grids
`;
    const bind = (yaml: string) =>
      compileAndBindGridsWorkflowSource(yaml, catalog(), async () =>
        ok({ source: "from table {TBL001} select {FLD001}", schemaHash: "a".repeat(64) }),
      );
    expect((await bind(source)).ok).toBe(true);
    expect((await bind(source.replace("inputs.approved", "inputs.unknown"))).ok).toBe(false);
    expect((await bind(source.replace("rowsKey: items", 'rowsKey: "${{ inputs.approved }}"'))).ok).toBe(false);
    expect((await bind(source.replace('approved: "${{ inputs.approved }}"', "items: forbidden"))).ok).toBe(false);
    const csv =
      source.slice(0, source.indexOf("        kind: json")) +
      `        kind: csv
        columns:
          - source: Name
            label: Item
`;
    expect((await bind(csv)).ok).toBe(true);
    expect((await bind(csv.replace("label: Item", 'label: "${{ inputs.approved }}"'))).ok).toBe(false);
    expect((await bind(csv.replace("source: Name", 'source: "${{ inputs.approved }}"'))).ok).toBe(false);
  });

  test("financial output uses existing header expressions but pins destination and column mappings", async () => {
    const source = `inputs:
  executionDate:
    type: text
steps:
  - query:
      source: from table Items select Name
      saveAs: report
  - generateDocument:
      data: report
      output:
        kind: sepa-xml
        version: 1
        header:
          destinationKey: finance-main
          debtorName: Example
          debtorIban: DE89370400440532013000
          executionDate: "\${{ inputs.executionDate }}"
        mapping:
          businessId: id
          endToEndId: reference
          amount: amount
          creditorName: name
          creditorIban: iban
          remittance: purpose
`;
    const bind = (yaml: string) =>
      compileAndBindGridsWorkflowSource(yaml, catalog(), async () =>
        ok({ source: "from table {TBL001} select {FLD001}", schemaHash: "a".repeat(64) }),
      );
    const valid = await bind(source);
    expect(valid.ok).toBe(true);
    expect(
      (
        await bind(
          source.replace(
            "      data: report",
            "      data: report\n      sourceVersions: [{tableId: TBL001, recordId: REC001, version: 1}]",
          ),
        )
      ).ok,
    ).toBe(true);
    expect((await bind(source.replace("type: text", "type: date"))).ok).toBe(true);
    for (const invalid of [
      source.replace("destinationKey: finance-main", 'destinationKey: "${{ inputs.executionDate }}"'),
      source.replace("amount: amount", 'amount: "${{ inputs.executionDate }}"'),
      source.replace("inputs.executionDate }}", "inputs.missing }}"),
      source.replace("type: text", "type: number"),
      source.replace("DE89370400440532013000", "DE00370400440532013000"),
      source.replace("version: 1", "version: 2"),
      source.replace('"${{ inputs.executionDate }}"', "2026-02-30"),
    ])
      expect((await bind(invalid)).ok).toBe(false);
  });

  test("rejects invalid literal query parameters before loading a schema", async () => {
    for (const [type, value] of [
      ["decimal", "not-a-number"],
      ["date", "2026-02-30"],
    ]) {
      let called = false;
      const source = `steps:\n  - query:\n      source: from table Items\n      parameters:\n        invalid:\n          type: ${type}\n          value: "${value}"\n`;
      const bound = await compileAndBindGridsWorkflowSource(source, catalog(), async () => {
        called = true;
        return ok({ source: "unused", schemaHash: "a".repeat(64) });
      });
      expect(bound.ok).toBe(false);
      expect(called).toBe(false);
      if (!bound.ok) expect(bound.diagnostics[0]?.code).toBe("query.parameterValue");
    }
  });
  test("query publication pins canonical source and exposes only a small typed result reference", async () => {
    const source = `inputs:\n  minimum:\n    type: text\nsteps:\n  - query:\n      source: from table Items select Name\n      parameters:\n        minimum:\n          type: decimal\n          value: \${{ inputs.minimum }}\n      saveAs: report\n  - setVariable:\n      name: count\n      value: \${{ report.rowCount }}\n`;
    const result = await compileAndBindGridsWorkflowSource(source, catalog(), async (_query, values) => {
      expect(values["params.minimum"]).toEqual({ decimal: "0" });
      return ok({ source: "from table {TBL001} select {FLD001}", schemaHash: "a".repeat(64) });
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toContain("from table {TBL001} select {FLD001}");
    expect(result.plan.bindings["steps.0.query.$query"]).toEqual({
      source: "from table {TBL001} select {FLD001}",
      schemaHash: "a".repeat(64),
    });
    const rows = await compileAndBindGridsWorkflowSource(source.replace("report.rowCount", "report.rows"), catalog(), async () =>
      ok({ source: "unused", schemaHash: "a".repeat(64) }),
    );
    expect(rows.ok).toBe(false);
  });

  test("document generation consumes typed query references and rejects mixed source modes", async () => {
    const prefix = "steps:\n  - query:\n      source: from table Items select Name\n      saveAs: report\n";
    for (const kind of ["csv", "json", "pdf", "xml"]) {
      const result = await compileAndBindGridsWorkflowSource(
        `${prefix}  - generateDocument:\n      data: report\n      output:\n        kind: ${kind}\n${kind === "pdf" || kind === "xml" ? '        body: "<report>{% for row in rows %}<p>{{ row.name }}</p>{% endfor %}</report>"\n' : ""}      saveAs: document\n`,
        catalog(),
        async () => ok({ source: "from table {TBL001} select {FLD001}", schemaHash: "a".repeat(64) }),
      );
      expect(result.ok).toBe(true);
    }
    for (const invalid of [
      "data: missing\n      output: { kind: csv }",
      "data: report\n      associatedData: missing\n      output: { kind: csv }",
      "data: report\n      template: Invoice\n      record: inputs.record\n      output: { kind: csv }",
      "data: report\n      output: { kind: json, delimiter: ';' }",
      "data: report\n      output: { kind: pdf }",
      'data: report\n      output: { kind: pdf, body: "{{ record.name }}" }',
      'data: report\n      output: { kind: pdf, body: "{% for row in rows %}" }',
      'data: report\n      output: { kind: xml, body: "<{{ document.number }}/>" }',
    ]) {
      const result = await compileAndBindGridsWorkflowSource(`${prefix}  - generateDocument:\n      ${invalid}\n`, catalog(), async () =>
        ok({ source: "from table {TBL001} select {FLD001}", schemaHash: "a".repeat(64) }),
      );
      expect(result.ok).toBe(false);
    }
  });

  test("queries fail closed without authorized schema or with interpolated source and incompatible parameter types", async () => {
    for (const source of [
      "steps:\n  - query:\n      source: from table Items select Name\n",
      'steps:\n  - query:\n      source: "${{ inputs.query }}"\n',
      "steps:\n  - query:\n      source: from table Items select Name\n      parameters:\n        minimum:\n          type: decimal\n          value: 12\n",
    ]) {
      const result = await compileAndBindGridsWorkflowSource(source, catalog());
      expect(result.ok).toBe(false);
    }
  });
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
      values:
        Name: "\${{ inputs.original.Status }}"
      saveAs: correction
  - updateRecord:
      record: correction
      set: {Name: Review}
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
      "steps.0.createCorrectionDraft.values.FLD001.$target": ids.name,
      "steps.0.createCorrectionDraft.values.FLD001": ids.status,
      "steps.1.updateRecord.set.FLD001": ids.name,
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

  test("rejects record-event triggers bound to a Combined table", async () => {
    const configured = await bindGridsWorkflow(
      await compile(`triggers:
  recordEvent:
    event: updated
    table: Overview
steps:
  - succeed:
      message: never
`),
      catalog(),
    );
    expect(configured.ok).toBe(false);
    if (!configured.ok) {
      expect(configured.diagnostics).toEqual([
        expect.objectContaining({
          code: "trigger.table",
          message: 'Record events are not available for Combined table "Overview"',
          path: ["triggers", "recordEvent", "table"],
        }),
      ]);
    }

    const inferred = await bindGridsWorkflow(
      await compile(`inputs:
  row:
    type: record
    table: Overview
triggers:
  recordEvent:
    event: updated
    with:
      row: "\${{ trigger.record }}"
steps:
  - succeed:
      message: never
`),
      catalog(),
    );
    expect(inferred.ok).toBe(false);
    if (!inferred.ok) expect(inferred.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["trigger.table"]);
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
        - finalizeRecord:
            record: inputs.item
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

  test("atomic locks bind record-list inputs and relations but reject scalar inputs", async () => {
    for (const lock of ["inputs.items", "inputs.item.Related archives", "inputs.label"]) {
      const result = await compileAndBindGridsWorkflowSource(
        `inputs:
  item: {type: record, table: Items}
  items: {type: recordList, table: Items}
  label: {type: text}
steps:
  - atomicRecords:
      locks: [${JSON.stringify(lock)}]
      checks:
        - table: Items
          where: [{field: Status, op: equals, value: Ready}]
          assert: notEmpty
      changes:
        - updateRecord: {record: inputs.item, set: {Status: Reserved}}
`,
        catalog(),
      );
      expect(result.ok, JSON.stringify(result)).toBe(lock !== "inputs.label");
    }
  });

  test("atomic finalization accepts only one record, not lists or scalar references", async () => {
    for (const record of ["inputs.item", "inputs.item.Current archive", "inputs.items", "inputs.item.Related archives", "inputs.label"]) {
      const result = await compileAndBindGridsWorkflowSource(
        `inputs:
  item: {type: record, table: Items}
  items: {type: recordList, table: Items}
  label: {type: text}
steps:
  - atomicRecords:
      locks: [inputs.item]
      checks:
        - table: Items
          where: [{field: Status, op: equals, value: Ready}]
          assert: notEmpty
      changes:
        - finalizeRecord: {record: ${JSON.stringify(record)}}
`,
        catalog(),
      );
      expect(result.ok, JSON.stringify(result)).toBe(record === "inputs.item" || record === "inputs.item.Current archive");
      if (!result.ok) expect(result.diagnostics.some((diagnostic) => diagnostic.code === "reference.type")).toBe(true);
    }
  });

  test("atomic relation finalization binds its change path, not the unrelated coordination lock", async () => {
    const result = await compileAndBindGridsWorkflowSource(
      `inputs:
  item: {type: record, table: Items}
steps:
  - atomicRecords:
      locks: [inputs.item]
      checks:
        - table: Items
          where: [{field: Status, op: equals, value: Ready}]
          assert: notEmpty
      changes:
        - finalizeRecord: {record: "inputs.item.Current archive"}
`,
      catalog(),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.plan.bindings["steps.0.atomicRecords.locks.0"]).toBeUndefined();
    expect(result.plan.bindings).toMatchObject({
      "steps.0.atomicRecords.changes.0.finalizeRecord.record": ids.current,
      "steps.0.atomicRecords.changes.0.finalizeRecord.record.$relationTarget": ids.archive,
      "steps.0.atomicRecords.changes.0.finalizeRecord.record.$relationCardinality": "single",
    });
  });

  test("deleteRecord binds a single record and audit references without accepting lists", async () => {
    for (const record of ["inputs.item", "inputs.item.Current archive", "inputs.items", "inputs.label"]) {
      const result = await compileAndBindGridsWorkflowSource(
        `inputs:
  item: {type: record, table: Items}
  items: {type: recordList, table: Items}
  label: {type: text}
steps:
  - deleteRecord:
      record: ${JSON.stringify(record)}
      audit:
        aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa: "\${{ inputs.item.Name }}"
      saveAs: removed
  - succeed:
      message: "Removed \${{ removed.recordId }}"
`,
        catalog(),
      );
      expect(result.ok, JSON.stringify(result)).toBe(record !== "inputs.items" && record !== "inputs.label");
      if (result.ok) {
        expect(result.plan.bindings["steps.0.deleteRecord.audit.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]).toBe(ids.name);
      } else {
        expect(result.diagnostics.some((diagnostic) => diagnostic.code === "reference.type")).toBe(true);
      }
    }
  });

  test("atomic GQL checks pin their own query and reject untyped or interpolated input", async () => {
    const source = `inputs:
  item: { type: record, table: Items, required: true }
steps:
  - atomicRecords:
      locks: [inputs.item]
      checks:
        - query:
            source: from table Items select Name
            parameters:
              threshold: { type: decimal, value: "100.00" }
          assert: notEmpty
      changes:
        - finalizeRecord: { record: inputs.item }
`;
    const result = await compileAndBindGridsWorkflowSource(source, catalog(), async (_query, values) => {
      expect(values["params.threshold"]).toEqual({ decimal: "0" });
      return { ok: true, data: { source: "from table Items select Name", schemaHash: "schema" } };
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.plan.bindings["steps.0.atomicRecords.checks.0.query.$query"]).toEqual({
        source: "from table Items select Name",
        schemaHash: "schema",
      });
    expect((await compileAndBindGridsWorkflowSource(source, catalog())).ok).toBe(false);
    for (const invalid of [
      source.replace('value: "100.00"', "value: 100"),
      source.replace("source: from table Items select Name", 'source: "${{ inputs.item.Name }}"'),
    ]) {
      const rejected = await compileAndBindGridsWorkflowSource(invalid, catalog());
      expect(rejected.ok).toBe(false);
    }
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

test("catalog snapshot roundtrip retains Combined table kind", async () => {
  const restored = restoreWorkflowCatalog(WorkflowCatalogSnapshotSchema.parse(snapshotWorkflowCatalog(catalog())));
  expect(restored.tables.refs.get("Overview")?.kind).toBe("federated");
  expect(restored.tables.refs.get("TBL003")?.kind).toBe("federated");
});
