import { describe, expect, test } from "bun:test";
import type { GridRecord } from "../contracts";
import type { CustomAppRowNavigation } from "../custom-apps/contracts";
import { customAppRowNavigationParams } from "./custom-app-records-query";

const uuid = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

const record = (id: string, data: Record<string, unknown>): GridRecord => ({
  id,
  shortId: "REC001",
  tableId: uuid(1),
  data,
  version: 1,
  deletedAt: null,
  createdBy: null,
  updatedBy: null,
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
});

describe("Custom App row relation navigation", () => {
  test("resolves complete row parameters and omits rows without a relation target", () => {
    const fieldId = uuid(2);
    const navigation: CustomAppRowNavigation = {
      kind: "navigate",
      pageId: "item",
      history: "push",
      params: {
        line_id: { source: "ROW", path: "id" },
        item_id: { source: "ROW", path: "relation", fieldId: "REL001" },
      },
    };
    const firstId = uuid(3);
    const secondId = uuid(4);

    expect(
      customAppRowNavigationParams(
        navigation,
        [firstId, secondId],
        [record(firstId, { [fieldId]: [uuid(5)] }), record(secondId, {})],
        new Map([["REL001", fieldId]]),
      ),
    ).toEqual({ [firstId]: { line_id: firstId, item_id: uuid(5) } });
    expect(customAppRowNavigationParams(navigation, [firstId], [record(firstId, { [fieldId]: [uuid(5)] })], new Map())).toEqual({});
  });
});
