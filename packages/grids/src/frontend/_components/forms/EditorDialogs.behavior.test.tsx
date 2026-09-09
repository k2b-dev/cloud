import { expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { PublicField, PublicForm } from "../../../api/public-dto";

const domTest = isServer ? test.skip : test;
const field: PublicField = {
  id: "FIELD1",
  tableId: "TABLE1",
  name: "Name",
  description: null,
  type: "text",
  config: {},
  position: 0,
  required: false,
  presentable: false,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: "2026-09-09T00:00:00Z",
  updatedAt: "2026-09-09T00:00:00Z",
};
const form: PublicForm = {
  id: "FORM01",
  tableId: "TABLE1",
  name: "Request",
  config: { fields: [{ kind: "user_input", fieldId: "FIELD1", required: false }] },
  publicToken: null,
  isActive: true,
  ownerUserId: null,
  position: 0,
  isDefault: false,
  deletedAt: null,
  createdAt: "2026-09-09T00:00:00Z",
  updatedAt: "2026-09-09T00:00:00Z",
};
const button = (document: Document, label: string) =>
  Array.from(document.querySelectorAll("button"))
    .filter((node) => node.textContent?.trim() === label)
    .at(-1)!;
const inputFor = (document: Document, label: string) => {
  const node = Array.from(document.querySelectorAll("label")).find((node) => node.textContent?.trim().replace(/\s*\*$/, "") === label)!;
  return document.getElementById(node.htmlFor) as HTMLInputElement;
};
const change = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

domTest("linked field settings show a retryable load failure and protect staged edits", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = Object.assign(
    async () => {
      reads++;
      return reads === 1 ? Response.json({ message: "Unavailable" }, { status: 503 }) : Response.json([field]);
    },
    { preconnect: originalFetch.preconnect },
  );
  const { openFormFieldSettingsDialog } = await import("./FormFieldSettings");
  const { dialogCore } = await import("@k2b/ui");
  try {
    void openFormFieldSettingsDialog({
      entry: { kind: "user_input", fieldId: field.id, required: false },
      field: { ...field, type: "relation", config: { targetTableId: "OTHER1" } },
    });
    await Bun.sleep(30);
    expect(dom.document.body.textContent).toContain("Could not load fields for linked records");
    button(dom.document, "Try again").click();
    await Bun.sleep(30);
    expect(reads).toBe(2);
    expect(dom.document.body.textContent).not.toContain("Could not load fields for linked records");
    change(inputFor(dom.document, "Label override (optional)"), "Linked item");
    button(dom.document, "Cancel").click();
    await Bun.sleep(10);
    expect(dom.document.body.textContent).toContain("Unsaved changes");
    button(dom.document, "Cancel").click();
    await Bun.sleep(10);
    expect(inputFor(dom.document, "Label override (optional)").value).toBe("Linked item");
  } finally {
    dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("field save retains partial success and retries only table display; all dismiss paths preserve dirty input", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let fieldWrites = 0;
  let tableWrites = 0;
  let saved = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      if (String(input).includes("/fields/")) {
        fieldWrites++;
        return Response.json({ ...field, name: "Updated" });
      }
      tableWrites++;
      return tableWrites === 1
        ? Response.json({ error: "Display unavailable" }, { status: 503 })
        : Response.json({ columns: [{ fieldId: field.id, label: "Display" }] });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { openFieldEditDialog } = await import("../fields/FieldEditorDialog");
  const { dialogCore } = await import("@k2b/ui");
  try {
    void openFieldEditDialog({
      field,
      tableKind: "stored",
      otherTables: [],
      fieldsByTable: {},
      tableColumns: [{ fieldId: field.id }],
      onSaved: () => {
        saved++;
      },
      onDeleted: () => false,
    });
    change(inputFor(dom.document, "Name"), "Updated");
    const dialog = dom.document.querySelector("dialog")!;
    dialog.oncancel?.call(dialog, new Event("cancel", { cancelable: true }));
    await Bun.sleep(10);
    expect(dom.document.body.textContent).toContain("Unsaved changes");
    button(dom.document, "Cancel").click();
    await Bun.sleep(10);
    expect(inputFor(dom.document, "Name").value).toBe("Updated");
    change(inputFor(dom.document, "Table column name"), "Display");
    button(dom.document, "Save").click();
    await Bun.sleep(30);
    expect(saved).toBe(1);
    expect(dom.document.body.textContent).toContain("Field saved. Table display could not be saved");
    expect(inputFor(dom.document, "Name").value).toBe("Updated");
    button(dom.document, "Save").click();
    await Bun.sleep(30);
    expect(fieldWrites).toBe(1);
    expect(tableWrites).toBe(2);
    expect(saved).toBe(1);
    expect(dom.document.querySelector(".k2b-panel-dialog__header")).toBeNull();
  } finally {
    dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("form editor keeps failed saves inline and canceling deletion keeps the editor", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = Object.assign(
    async () => {
      writes++;
      return Response.json({ error: "Unavailable" }, { status: 503 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { openFormEditorDialog } = await import("./FormEditorDialog");
  const { dialogCore } = await import("@k2b/ui");
  try {
    void openFormEditorDialog({ form, tableFields: [field] });
    change(inputFor(dom.document, "Name"), "");
    button(dom.document, "Save").click();
    expect(dom.document.body.textContent).toContain("Name is required");
    expect(writes).toBe(0);
    change(inputFor(dom.document, "Name"), "Updated request");
    button(dom.document, "Save").click();
    await Bun.sleep(30);
    expect(inputFor(dom.document, "Name").value).toBe("Updated request");
    expect(dom.document.body.textContent).toContain("Failed to save form");
    expect(dom.document.querySelectorAll(".k2b-panel-dialog__header").length).toBe(1);
    button(dom.document, "Delete form").click();
    await Bun.sleep(10);
    button(dom.document, "Cancel").click();
    await Bun.sleep(10);
    expect(writes).toBe(1);
    expect(inputFor(dom.document, "Name").value).toBe("Updated request");
  } finally {
    dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("new form keeps its name when creation fails and blocks dismissal while creating", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let finish: ((response: Response) => void) | undefined;
  globalThis.fetch = Object.assign(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
    { preconnect: originalFetch.preconnect },
  );
  const { createForm } = await import("./FormsManager");
  const { dialogCore } = await import("@k2b/ui");
  try {
    void createForm({ tableId: "TABLE1", fields: [field] }, "en");
    change(inputFor(dom.document, "Name"), "New request");
    button(dom.document, "Create").click();
    await Bun.sleep(10);
    const dialog = dom.document.querySelector("dialog")!;
    dialog.oncancel?.call(dialog, new Event("cancel", { cancelable: true }));
    await Bun.sleep(10);
    expect(dom.document.body.textContent).not.toContain("Unsaved changes");
    expect(inputFor(dom.document, "Name").value).toBe("New request");
    finish!(Response.json({ message: "Unavailable" }, { status: 503 }));
    await Bun.sleep(30);
    expect(inputFor(dom.document, "Name").value).toBe("New request");
    expect(dom.document.body.textContent).toContain("Unavailable");
  } finally {
    dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("form deletion is owned by the editor and notifies only after the confirmed request", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let deleted = 0;
  let notified = 0;
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("DELETE");
      deleted++;
      return Response.json({ ok: true });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { openFormEditorDialog } = await import("./FormEditorDialog");
  const { dialogCore } = await import("@k2b/ui");
  try {
    void openFormEditorDialog({
      form,
      tableFields: [field],
      onDelete: () => {
        notified++;
      },
    });
    button(dom.document, "Delete form").click();
    await Bun.sleep(10);
    expect(deleted).toBe(0);
    expect(notified).toBe(0);
    button(dom.document, "Delete").click();
    await Bun.sleep(30);
    expect(deleted).toBe(1);
    expect(notified).toBe(1);
    expect(dom.document.querySelector("dialog")).toBeNull();
  } finally {
    dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("embedded form reports dirty and pending state and clears dirty after success", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const OriginalFormData = globalThis.FormData;
  globalThis.FormData = dom.window.FormData as unknown as typeof FormData;
  const dirty: boolean[] = [];
  const pending: boolean[] = [];
  let finish: ((response: Response) => void) | undefined;
  globalThis.fetch = Object.assign(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
    { preconnect: originalFetch.preconnect },
  );
  const { default: FormSubmit } = await import("./PublicFormSubmit.island");
  const dispose = render(
    () => (
      <FormSubmit
        form={{ id: "FORM01", name: form.name, config: form.config }}
        fields={[field]}
        submitUrl="/test-only"
        onDirtyChange={(value) => dirty.push(value)}
        onSubmittingChange={(value) => pending.push(value)}
      />
    ),
    dom.root,
  );
  try {
    change(inputFor(dom.document, "Name"), "Example");
    expect(dirty.at(-1)).toBe(true);
    dom.document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Bun.sleep(10);
    expect(pending).toEqual([true]);
    expect(dom.document.querySelector("fieldset")!.disabled).toBe(true);
    finish!(Response.json({}));
    await Bun.sleep(30);
    expect(pending).toEqual([true, false]);
    expect(dirty.at(-1)).toBe(false);
    expect(dom.document.body.textContent).toContain("Saved");
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    globalThis.FormData = OriginalFormData;
    dom.cleanup();
  }
});
