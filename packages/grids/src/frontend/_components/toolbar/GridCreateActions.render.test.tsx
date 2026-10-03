import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { PublicForm } from "../../../api/public-dto";
import "../ssr-test-plugin";

const { GridCreateActions, offersGridCreateActions } = await import("./GridCreateActions");

describe("GridCreateActions", () => {
  test("explains why records cannot be added when direct changes and forms are unavailable", () => {
    const html = renderToString(() =>
      createComponent(GridCreateActions, {
        baseId: "BASE01",
        tableId: "TABLE1",
        tableName: "Orders",
        disableDirectInsert: false,
        fields: [],
        forms: [],
        canWrite: true,
        canDirectWrite: false,
        canSubmitForms: false,
      }),
    );

    expect(html).toContain("Add record");
    expect(html).toContain("This table does not allow changes from direct editing or forms.");
    expect(html).toContain("Add record unavailable:");
    expect(html).toContain("disabled");
  });

  test("offersGridCreateActions is true exactly when the component renders a control", () => {
    const form: PublicForm = {
      id: "FORM01",
      tableId: "TABLE1",
      name: "Order intake",
      config: { fields: [] },
      publicToken: null,
      isActive: true,
      ownerUserId: null,
      position: 0,
      isDefault: false,
      deletedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    for (const canWrite of [true, false])
      for (const canDirectWrite of [true, false])
        for (const canSubmitForms of [true, false])
          for (const disableDirectInsert of [true, false])
            for (const forms of [[], [form]] satisfies PublicForm[][]) {
              const access = { canWrite, canDirectWrite, canSubmitForms, disableDirectInsert, forms };
              const html = renderToString(() =>
                createComponent(GridCreateActions, { baseId: "BASE01", tableId: "TABLE1", tableName: "Orders", fields: [], ...access }),
              );
              expect({ access, rendered: html.includes("<button") }).toEqual({ access, rendered: offersGridCreateActions(access) });
            }
  });
});
