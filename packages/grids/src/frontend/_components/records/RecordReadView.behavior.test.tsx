import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;
domTest(
  "relation names update when detail labels arrive after the record",
  async () => {
    const dom = createDomTestHarness();
    const { PublicFieldSchema, PublicGridRecordSchema } = await import("../../../api/public-dto");
    const { default: RecordReadView } = await import("./RecordReadView");
    const timestamp = "2026-01-01T00:00:00.000Z";
    const field = PublicFieldSchema.parse({
      id: "FIELD1",
      tableId: "TABLE1",
      name: "Customer",
      description: "",
      type: "relation",
      config: { targetTableId: "TABLE2", cardinality: "single" },
      position: 0,
      required: false,
      presentable: false,
      hideInTable: false,
      defaultValue: null,
      indexed: false,
      uniqueConstraint: false,
      deletedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const record = PublicGridRecordSchema.parse({
      id: "REC001",
      tableId: "TABLE1",
      data: { FIELD1: ["REC002"] },
      version: 1,
      createdBy: "00000000-0000-4000-8000-000000000001",
      updatedBy: "00000000-0000-4000-8000-000000000001",
      deletedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const [labels, setLabels] = createSignal<Record<string, string>>({});
    const dispose = render(
      () =>
        createComponent(RecordReadView, {
          cloudUrl: "https://cloud.example",
          baseId: "BASE01",
          tableId: "TABLE1",
          tableName: "Invoices",
          fields: [field],
          record,
          get relationLabels() {
            return labels();
          },
        }),
      dom.root,
    );
    try {
      expect(dom.root.textContent).toContain("Unavailable record");
      setLabels({ REC002: "Lichtblick" });
      await Bun.sleep(0);
      expect(dom.root.textContent).toContain("Lichtblick");
      expect(dom.root.textContent).not.toContain("Unavailable record");
      setLabels({});
      await Bun.sleep(0);
      expect(dom.root.textContent).not.toContain("Lichtblick");
    } finally {
      dispose();
      dom.cleanup();
    }
  },
  30_000,
);
