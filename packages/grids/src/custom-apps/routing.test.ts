import { describe, expect, test } from "bun:test";
import type { CustomAppDefinition } from "./contracts";
import {
  customAppActionHref,
  customAppActionStatusUrl,
  customAppActionUrl,
  customAppCommentsUrl,
  customAppDocumentDownloadUrl,
  customAppFormSubmitUrl,
  customAppFormSuccessHref,
  customAppPageHref,
  customAppRecordFilesUrl,
  customAppRecordsUrl,
  customAppRecordUpdateUrl,
  customAppRowActionUrl,
  customAppRowHref,
  customAppScannerRunUrl,
  customAppScannerUrl,
  resolveCustomAppPage,
  resolveCustomAppPageParams,
  resolvePageRecordId,
} from "./routing";

const uuid = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

const definition: CustomAppDefinition = {
  schemaVersion: 5,
  kind: "grids.custom-app",
  id: "APP001",
  baseId: "BASE01",
  name: "Requests",
  startPageId: "home",
  pages: [
    {
      id: "home",
      title: "Requests",
      navigation: { visible: true },
      parameters: {},
      rows: [{ id: "main", columns: [{ id: "content", span: 12, blocks: [{ id: "copy", type: "markdown", markdown: "Hello" }] }] }],
    },
    {
      id: "detail",
      title: "Request",
      navigation: { visible: false },
      parameters: { request_id: { type: "record", tableId: "TAB001", required: true } },
      record: { tableId: "TAB001", id: { source: "PARAMS", path: "request_id" } },
      rows: [
        {
          id: "main",
          columns: [{ id: "content", span: 12, blocks: [{ id: "record", type: "record", fieldIds: ["FLD001"], editableFieldIds: [] }] }],
        },
      ],
    },
  ],
};

describe("Grids App routing", () => {
  test("uses the start page and resolves an explicit route-only page", () => {
    expect(resolveCustomAppPage(definition)?.id).toBe("home");
    expect(resolveCustomAppPage(definition, "detail")?.id).toBe("detail");
    expect(resolveCustomAppPage(definition, "missing")).toBeNull();
  });

  test("accepts only a valid page record id", () => {
    const page = definition.pages[1]!;
    expect(resolvePageRecordId(page, { request_id: uuid(9) })).toBe(uuid(9));
    expect(resolvePageRecordId(page, { request_id: "not-a-record" })).toBeNull();
    expect(resolvePageRecordId(page, {})).toBeNull();
    expect(resolvePageRecordId(definition.pages[0]!, {})).toBeUndefined();
    expect(resolveCustomAppPageParams(page, { request_id: uuid(9) })).toEqual({ request_id: uuid(9) });
    expect(resolveCustomAppPageParams(page, { request_id: "bad" })).toBeNull();
  });

  test("builds stable page and row navigation URLs", () => {
    expect(customAppPageHref("abc12", "detail", { request_id: uuid(9) })).toBe(`/apps/abc12/detail?request_id=${uuid(9)}`);
    expect(
      customAppRowHref(
        "abc12",
        { kind: "navigate", pageId: "detail", history: "push", params: { request_id: { source: "ROW", path: "id" } } },
        uuid(9),
      ),
    ).toBe(`/apps/abc12/detail?request_id=${uuid(9)}`);
    const relationNavigation = {
      kind: "navigate" as const,
      pageId: "detail",
      history: "push" as const,
      params: { request_id: { source: "ROW" as const, path: "relation" as const, fieldId: uuid(4) } },
    };
    expect(customAppRowHref("abc12", relationNavigation, uuid(8), { request_id: uuid(9) })).toBe(
      `/apps/abc12/detail?request_id=${uuid(9)}`,
    );
    expect(customAppRowHref("abc12", relationNavigation, uuid(8))).toBeNull();
  });

  test("builds internal Form submit and replace-navigation targets", () => {
    expect(customAppFormSubmitUrl("abc12", "detail", "edit", { request_id: uuid(9) })).toBe(
      `/api/grids/apps/runtime/abc12/detail/edit/submit?request_id=${uuid(9)}`,
    );
    expect(
      customAppFormSuccessHref(
        "abc12",
        { kind: "navigate", pageId: "detail", params: { request_id: { source: "RESULT", path: "recordId" } } },
        {},
        uuid(10),
      ),
    ).toBe(`/apps/abc12/detail?request_id=${uuid(10)}`);
  });

  test("builds an internal Comments endpoint with the declared page parameters", () => {
    expect(customAppCommentsUrl("abc12", "detail", "discussion", { request_id: uuid(9) })).toBe(
      `/api/grids/apps/runtime/abc12/detail/discussion/comments?request_id=${uuid(9)}`,
    );
  });

  test("builds an internal Record update endpoint with the declared page parameters", () => {
    expect(customAppRecordUpdateUrl("abc12", "detail", "record", { request_id: uuid(9) })).toBe(
      `/api/grids/apps/runtime/abc12/detail/record/record?request_id=${uuid(9)}`,
    );
  });

  test("builds an internal Record files endpoint with the declared page parameters", () => {
    expect(customAppRecordFilesUrl("abc12", "detail", "record", uuid(4), { request_id: uuid(9) })).toBe(
      `/api/grids/apps/runtime/abc12/detail/record/record/files/${uuid(4)}?request_id=${uuid(9)}`,
    );
  });

  test("builds exact internal action targets", () => {
    expect(customAppActionUrl("abc12", "detail", "actions", "approve", { request_id: uuid(9) })).toBe(
      `/api/grids/apps/runtime/abc12/detail/actions/actions/approve?request_id=${uuid(9)}`,
    );
    expect(
      customAppActionHref(
        "abc12",
        {
          id: "open",
          label: "Open",
          kind: "navigate",
          pageId: "detail",
          history: "replace",
          params: { request_id: { source: "RECORD", path: "id" } },
        },
        {},
        uuid(9),
      ),
    ).toBe(`/apps/abc12/detail?request_id=${uuid(9)}`);
    expect(
      customAppActionHref(
        "abc12",
        {
          id: "open",
          label: "Open",
          kind: "navigate",
          pageId: "detail",
          history: "push",
          params: { request_id: { source: "PARAMS", path: "request_id" } },
        },
        {},
      ),
    ).toBeNull();
    expect(customAppRowActionUrl("abc12", "detail", "items", "reserve", { request_id: uuid(9) })).toBe(
      `/api/grids/apps/runtime/abc12/detail/items/row-actions/reserve?request_id=${uuid(9)}`,
    );
    expect(customAppRecordsUrl("abc12", "detail", "items", { request_id: uuid(9) })).toBe(
      `/api/grids/apps/runtime/abc12/detail/items/records?request_id=${uuid(9)}`,
    );
    expect(customAppActionStatusUrl("abc12", "detail", "items", "reserve", uuid(10), { request_id: uuid(9) })).toBe(
      `/api/grids/apps/runtime/abc12/detail/items/actions/reserve/runs/${uuid(10)}?request_id=${uuid(9)}`,
    );
    expect(customAppDocumentDownloadUrl("abc12", "detail", "record", uuid(10), { request_id: uuid(9) })).toBe(
      `/api/grids/apps/runtime/abc12/detail/record/documents/${uuid(10)}/download?request_id=${uuid(9)}`,
    );
    expect(customAppScannerUrl("abc12", "detail", "returns", { request_id: uuid(9) })).toBe(
      `/api/grids/apps/runtime/abc12/detail/returns/scanner?request_id=${uuid(9)}`,
    );
    expect(customAppScannerRunUrl("abc12", "detail", "returns", uuid(10), { request_id: uuid(9) })).toBe(
      `/api/grids/apps/runtime/abc12/detail/returns/scanner/runs/${uuid(10)}?request_id=${uuid(9)}`,
    );
  });

  test("encodes every runtime path segment and keeps query parameters stable", () => {
    expect(customAppActionUrl("app/id", "page id", "block?", "run#", { z: "last", a: "first value" })).toBe(
      "/api/grids/apps/runtime/app%2Fid/page%20id/block%3F/actions/run%23?a=first+value&z=last",
    );
  });
});

test("record relation navigation needs the server-resolved relation, never substitutes the source record", () => {
  const action = {
    id: "invoice",
    label: "Invoice",
    kind: "navigate" as const,
    pageId: "bill",
    history: "push" as const,
    params: { bill_id: { source: "RECORD" as const, path: "relation" as const, fieldId: "FIELD1" } },
  };
  expect(customAppActionHref("APP001", action, {}, "PAY001")).toBeNull();
  expect(customAppActionHref("APP001", action, {}, "PAY001", { bill_id: "BILL01" })).toBe("/apps/APP001/bill?bill_id=BILL01");
});
