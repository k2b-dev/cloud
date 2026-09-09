import { describe, expect, test } from "bun:test";

describe("App Records table actions", () => {
  test("renders plural accessible row actions and sends the selected row id", async () => {
    const source = await Bun.file(new URL("./RecordsTable.island.tsx", import.meta.url)).text();

    expect(source).toContain("<For each={props.rowActions ?? []}>");
    expect(source).toContain("renderActions={");
    expect(source).toContain("<FieldValue");
    expect(source).toContain("<IconButton");
    expect(source).toContain("label={actionLabel(row.recordId!, action)}");
    expect(source).toContain("label={actionLabel(record.id, action)}");
    expect(source).toContain("operation: active.operation");
    expect(source).toContain("body: { rowId, search: appliedQuery() || undefined, cursor: cursor() || undefined }");
    expect(source).toContain("event.stopPropagation()");
    expect(source).toContain("ti ti-external-link");
    expect(source).toContain('class="group font-medium text-primary"');
    expect(source).toContain("whitespace-pre-wrap break-words underline-offset-2 group-hover:underline group-focus-visible:underline");
    expect(source).toContain('field?.type === "date" ? "whitespace-nowrap tabular-nums" : "whitespace-pre-wrap break-words"');
    expect(source).toContain('["text", "longtext", "relation"].includes(column.type) ? "min-w-48" : "min-w-32"');
    expect(source).toContain('class="overflow-x-auto"');
    expect(source).toContain("result().rowNavigationParams?.[row.recordId]");
    expect(source).toContain("await loadPage(cursor(), appliedQuery(), history())");
    expect(source).toContain("window.setTimeout(() => void loadPage(null, value.trim(), []), 250)");
    expect(source).toContain('<DataTable.Header title={props.title} as="h2" size="md" />');
    expect(source).toContain("<DataTable.Footer>");
    expect(source).toContain("props.preview || Boolean(pendingKey())");
    expect(source).toContain("if (props.preview || !props.endpoint) return");
    expect(source).toContain("prompts.confirm");
    expect(source).toContain('url.searchParams.set("_search", nextQuery)');
    expect(source).toContain('url.searchParams.set("_cursor", nextCursor)');
    expect(source).not.toContain("window.confirm");
  });

  test("does not retain the removed Bulk action surface", async () => {
    const source = await Bun.file(new URL("./RecordsTable.island.tsx", import.meta.url)).text();

    expect(source).not.toContain("bulkActions");
    expect(source).not.toContain("recordIds");
    expect(source).not.toContain("Select page");
  });
});
