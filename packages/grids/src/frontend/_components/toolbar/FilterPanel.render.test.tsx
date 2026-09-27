import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { PublicFieldSchema } from "../../../api/public-dto";
import "../ssr-test-plugin";

const { default: FilterPanel } = await import("./FilterPanel");

test("relation filter chips name the records they filter by", () => {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const customer = PublicFieldSchema.parse({
    id: "FIELD2",
    tableId: "TABLE1",
    name: "Customer",
    description: "",
    type: "relation",
    config: { targetTableId: "TABLE2" },
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
  const html = renderToString(() =>
    createComponent(FilterPanel, {
      fields: [customer],
      rows: () => [{ fieldId: "FIELD2", op: "containsAny", value: ["REC002"] }],
      onRowsChange: () => {},
      relationLabels: { REC002: "Acme" },
    }),
  );

  expect(html).toContain("Acme");
  expect(html).not.toContain("Unavailable record");
});
