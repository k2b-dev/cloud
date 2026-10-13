import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../ssr-test-plugin";
import RecordReferencedBy, {
  groupReferencedByItems,
  REFERENCED_BY_PAGE_SIZE,
  type ReferencedByItem,
  referencedByActionTitle,
  referencedByEndpoint,
} from "./RecordReferencedBy";

const item = (recordId: string, overrides: Partial<ReferencedByItem> = {}): ReferencedByItem => ({
  sourceTableId: "TABLE1",
  sourceTableName: "Orders",
  sourceRecordId: recordId,
  sourceRecordLabel: `Order ${recordId}`,
  relationFieldId: "FIELD1",
  relationFieldName: "Customer",
  ...overrides,
});

describe("RecordReferencedBy", () => {
  test("groups pages by source table and relation field and removes overlap duplicates", () => {
    const groups = groupReferencedByItems([
      item("REC001"),
      item("REC001"),
      item("REC002"),
      item("REC003", { relationFieldId: "FIELD2", relationFieldName: "Billing customer" }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.items.map((entry) => entry.sourceRecordId)).toEqual(["REC001", "REC002"]);
    expect(groups[1]).toMatchObject({ fieldName: "Billing customer", items: [{ sourceRecordId: "REC003" }] });
    expect(referencedByActionTitle(item("REC001"))).toBe("Customer · Order REC001");
  });

  test("is always visible and requests bounded five-item pages", () => {
    const html = renderToString(() => createComponent(RecordReferencedBy, { baseId: "BASE01", tableId: "TABLE1", recordId: "REC001" }));

    expect(REFERENCED_BY_PAGE_SIZE).toBe(5);
    expect(referencedByEndpoint("TABLE1", "REC001")).toEndWith("/referenced-by?limit=5");
    expect(html).toContain("Referenced by");
    expect(html).toContain("ti-link-plus");
    expect(html).not.toContain("<details");
  });
});
