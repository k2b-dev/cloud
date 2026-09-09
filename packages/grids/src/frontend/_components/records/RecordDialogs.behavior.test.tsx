import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { PublicField, PublicGridRecord } from "../../../api/public-dto";

const domTest = isServer ? test.skip : test;
const field = (id = "FIELD1", type = "text"): PublicField => ({
  id,
  tableId: "TABLE1",
  name: id,
  type,
  config: {},
  description: null,
  position: 0,
  required: false,
  presentable: false,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

domTest("computed column required values stay inline in the editor", async () => {
  const dom = createDomTestHarness();
  const { openComputedColumnDialog } = await import("../records-view/ComputedColumnDialog");
  const { dialogCore } = await import("@k2b/ui");
  try {
    void openComputedColumnDialog({ fields: [], currentTableId: "TABLE1", baseId: "BASE01", tableId: "TABLE1" });
    Array.from(dom.document.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Save")!
      .click();
    expect(dom.document.querySelectorAll("dialog")).toHaveLength(1);
    expect(dom.document.querySelectorAll(".k2b-dialog__panel")).toHaveLength(0);
    expect(dom.document.querySelector('[aria-invalid="true"]')).not.toBeNull();
  } finally {
    dialogCore.close();
    dom.cleanup();
  }
});

domTest("an unrelated forbidden export target does not block available relation fields", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) =>
      String(input).includes("TARGETA")
        ? Response.json({ message: "No access to target A" }, { status: 403 })
        : Response.json([{ ...field("TARGETF"), tableId: "TARGETB", name: "Available target field" }]),
    { preconnect: originalFetch.preconnect },
  );
  const { openExportRecordsDialog } = await import("./ExportRecordsDialog");
  const { dialogCore } = await import("@k2b/ui");
  try {
    void openExportRecordsDialog({
      tableId: "TABLE1",
      query: {},
      fields: [
        { ...field("RELATA", "relation"), hideInTable: true, config: { targetTableId: "TARGETA", cardinality: "single" } },
        { ...field("RELATB", "relation"), config: { targetTableId: "TARGETB", cardinality: "single" } },
      ],
    });
    await Bun.sleep(30);
    const label = Array.from(dom.document.querySelectorAll("label")).find((node) => node.textContent?.includes("Relation output"))!;
    dom.document.getElementById(label.htmlFor)!.click();
    await Bun.sleep(20);
    dom.document.querySelector<HTMLButtonElement>('[role="option"][aria-label="Selected fields"]')!.click();
    await Bun.sleep(20);
    expect(dom.document.body.textContent).not.toContain("No access to target A");
    expect(dom.document.body.textContent).toContain("Target fields");
    expect(Array.from(dom.document.querySelectorAll("button")).find((node) => node.textContent?.trim() === "Export")!.disabled).toBe(false);
  } finally {
    dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("table publication errors remain visible with a retry action", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = Object.assign(
    async () => (++reads === 1 ? Response.json({ message: "Publication load failed" }, { status: 503 }) : Response.json([])),
    { preconnect: originalFetch.preconnect },
  );
  const { openTableSettingsDialog } = await import("../dialogs/TableAdminDialogs");
  const { dialogCore } = await import("@k2b/ui");
  try {
    void openTableSettingsDialog({
      table: {
        id: "TABLE1",
        baseId: "BASE01",
        kind: "stored",
        name: "Items",
        description: null,
        icon: null,
        columns: [],
        displayConfig: { mode: "table" },
        auditPolicy: {},
        mutationPolicy: { mode: "all" },
        disableDirectInsert: false,
      },
      fields: [],
      canManageBase: true,
      onSaved: () => {},
      onMutationPolicySaved: () => {},
    });
    await Bun.sleep(30);
    expect(dom.document.body.textContent).toContain("Publication load failed");
    expect(dom.document.querySelectorAll("dialog")).toHaveLength(1);
    Array.from(dom.document.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Retry")!
      .click();
    await Bun.sleep(30);
    expect(reads).toBe(2);
    expect(dom.document.body.textContent).not.toContain("Publication load failed");
  } finally {
    dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("conflict recovery reviews current values and rebases only untouched fields before an explicit retry", async () => {
  const dom = createDomTestHarness();
  const { openRecordUpsertDialog, RecordSaveConflictError } = await import("./RecordUpsertDialog");
  const { dialogCore } = await import("@k2b/ui");
  const original: PublicGridRecord = {
    id: "RECORD",
    tableId: "TABLE1",
    version: 1,
    data: { FIELD1: "Old", FIELD2: "Old other" },
    deletedAt: null,
    createdBy: null,
    updatedBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const attempts: Array<{ values: Record<string, unknown>; version?: number }> = [];
  const auditedFields: string[][] = [];
  try {
    const result = openRecordUpsertDialog({
      mode: "edit",
      fields: [field(), field("FIELD2")],
      baseId: "BASE01",
      record: original,
      reloadRecord: async () => ({ ...original, version: 2, data: { FIELD1: "Their edit", FIELD2: "New other" } }),
      beforeSubmit: async (values, baselineData) => {
        auditedFields.push(Object.keys(values).filter((key) => JSON.stringify(values[key]) !== JSON.stringify(baselineData[key])));
        return true;
      },
      onSubmit: async (values, version) => {
        attempts.push({ values, version });
        if (version === 1) throw new RecordSaveConflictError("Conflict");
        if (attempts.length === 2) throw new Error("Temporary failure");
      },
    });
    const input = dom.document.querySelector<HTMLInputElement>('input[name="FIELD1"]')!;
    input.value = "My edit";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    dom.document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Bun.sleep(20);
    const button = (label: string) =>
      Array.from(dom.document.querySelectorAll("button")).find((node) => node.textContent?.trim() === label)!;
    expect(button("Save").disabled).toBe(true);
    button("Compare current record").click();
    await Bun.sleep(20);
    expect(Array.from(dom.document.querySelectorAll("input")).some((node) => node.value === "Their edit")).toBe(true);
    expect(attempts).toHaveLength(1);
    button("Keep my edits on this version").click();
    await Bun.sleep(20);
    expect(input.value).toBe("My edit");
    expect(dom.document.querySelector<HTMLInputElement>('input[name="FIELD2"]')!.value).toBe("New other");
    expect(attempts).toHaveLength(1);
    dom.document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Bun.sleep(20);
    expect(attempts[1]).toEqual({ values: { FIELD1: "My edit", FIELD2: "New other" }, version: 2 });
    expect(auditedFields).toEqual([["FIELD1"], ["FIELD1"]]);
    const other = dom.document.querySelector<HTMLInputElement>('input[name="FIELD2"]')!;
    other.value = "Old other";
    other.dispatchEvent(new Event("input", { bubbles: true }));
    dom.document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await result;
    expect(auditedFields[2]).toEqual(["FIELD1", "FIELD2"]);
    expect(attempts[2]).toEqual({ values: { FIELD1: "My edit", FIELD2: "Old other" }, version: 2 });
  } finally {
    dialogCore.close();
    dom.cleanup();
  }
});

domTest("record drafts survive validation and conflict failures, and pending submits cannot dismiss or repeat", async () => {
  const dom = createDomTestHarness();
  const { openRecordUpsertDialog } = await import("./RecordUpsertDialog");
  const { dialogCore } = await import("@k2b/ui");
  let requests = 0;
  let finish: (() => void) | undefined;
  const saved = openRecordUpsertDialog({
    mode: "create",
    fields: [field()],
    baseId: "BASE01",
    onSubmit: async (values) => {
      expect(values.FIELD1).toBe("My draft");
      requests++;
      if (requests === 1) throw new Error("Value must be unique");
      if (requests === 2) throw new Error("Record changed. Reload before saving.");
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  });
  try {
    const input = dom.document.querySelector<HTMLInputElement>('input[name="FIELD1"]')!;
    input.value = "My draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const submit = () => dom.document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    submit();
    await Bun.sleep(20);
    expect(dom.document.body.textContent).toContain("Value must be unique");
    expect(input.value).toBe("My draft");
    submit();
    await Bun.sleep(20);
    expect(dom.document.body.textContent).toContain("Record changed");
    expect(input.value).toBe("My draft");
    submit();
    await Bun.sleep(20);
    const dialog = dom.document.querySelector("dialog")!;
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    submit();
    expect(requests).toBe(3);
    expect(dom.document.querySelector("dialog")).not.toBeNull();
    expect(dom.document.querySelector("fieldset")!.disabled).toBe(true);
    finish!();
    expect(await saved).toEqual({ FIELD1: "My draft" });
    expect(dom.document.querySelector("dialog")).toBeNull();
  } finally {
    dialogCore.close();
    dom.cleanup();
  }
});

domTest("Escape asks before discarding a record draft", async () => {
  const dom = createDomTestHarness();
  const { openRecordUpsertDialog } = await import("./RecordUpsertDialog");
  const { dialogCore } = await import("@k2b/ui");
  try {
    const result = openRecordUpsertDialog({ mode: "create", fields: [field()], baseId: "BASE01", onSubmit: async () => {} });
    const input = dom.document.querySelector<HTMLInputElement>('input[name="FIELD1"]')!;
    input.value = "Keep this";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    dom.document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
    await Bun.sleep(20);
    expect(dom.document.body.textContent).toContain("Unsaved changes");
    Array.from(dom.document.querySelectorAll<HTMLButtonElement>(".k2b-dialog__actions button"))
      .find((button) => button.textContent?.trim() === "Cancel")!
      .click();
    await Bun.sleep(20);
    expect(input.value).toBe("Keep this");
    dom.document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
    await Bun.sleep(20);
    Array.from(dom.document.querySelectorAll<HTMLButtonElement>(".k2b-dialog__actions button"))
      .find((button) => button.textContent?.trim() === "Discard")!
      .click();
    expect(await result).toBeNull();
  } finally {
    while (dialogCore.isOpen()) dialogCore.close();
    dom.cleanup();
  }
});

domTest("form cross-field errors appear once after submit and disappear when corrected", async () => {
  const dom = createDomTestHarness();
  const { openFormModal } = await import("./FormSubmitModal");
  const { dialogCore } = await import("@k2b/ui");
  try {
    void openFormModal(
      {
        id: "FORM01",
        tableId: "TABLE1",
        name: "Test form",
        publicToken: null,
        isActive: true,
        ownerUserId: null,
        position: 0,
        isDefault: false,
        deletedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        config: {
          fields: [
            { kind: "user_input", fieldId: "FIELD1" },
            { kind: "user_input", fieldId: "FIELD2" },
          ],
          validations: [{ leftFieldId: "FIELD1", rightFieldId: "FIELD2", operator: "lte", message: "Start must not exceed end" }],
        },
      },
      [field("FIELD1", "number"), field("FIELD2", "number")],
    );
    const set = (name: string, value: string) => {
      const input = dom.document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("FIELD1", "20");
    set("FIELD2", "10");
    expect(dom.document.body.textContent).not.toContain("Start must not exceed end");
    dom.document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Bun.sleep(20);
    expect(dom.document.body.textContent!.split("Start must not exceed end").length - 1).toBe(1);
    set("FIELD1", "5");
    expect(dom.document.body.textContent).not.toContain("Start must not exceed end");
  } finally {
    while (dialogCore.isOpen()) dialogCore.close();
    dom.cleanup();
  }
});
