import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;
const question = { id: "00000000-0000-4000-8000-000000000001", type: "text" as const, label: "Reason", required: true };

domTest("public audit field references reject internal UUIDs and malformed IDs", async () => {
  const dom = createDomTestHarness();
  const { PublicTableAuditPolicySchema } = await import("../../../contracts");
  try {
    for (const fieldId of ["00000000-0000-4000-8000-000000000001", "not an id", ""]) {
      expect(
        PublicTableAuditPolicySchema.safeParse({
          update: {
            enabled: true,
            scope: "selected",
            fieldIds: [fieldId],
            questions: [question],
          },
        }).success,
      ).toBe(false);
    }
  } finally {
    dom.cleanup();
  }
});

domTest("audit policy accepts selected public field IDs and explains incomplete requirements inline", async () => {
  const dom = createDomTestHarness();
  const { openAuditPolicyDialog } = await import("./AuditPolicyDialog");
  const { dialogCore } = await import("@k2b/ui");
  const button = (label: string) => Array.from(dom.document.querySelectorAll("button")).find((item) => item.textContent?.trim() === label)!;
  try {
    const result = openAuditPolicyDialog({
      tableName: "Loans",
      fields: [],
      value: {
        update: { enabled: true, scope: "selected", fieldIds: ["FIELD1"], questions: [question] },
      },
    });
    button("Apply").click();
    expect((await result)?.update?.fieldIds).toEqual(["FIELD1"]);

    void openAuditPolicyDialog({ tableName: "Loans", fields: [], value: { delete: { enabled: true, questions: [] } } });
    button("Apply").click();
    await Bun.sleep(5);
    expect(dom.document.body.textContent).toContain("Add at least one question, or turn off this requirement.");
    expect(dom.document.querySelectorAll("dialog").length).toBe(1);
  } finally {
    dialogCore.close();
    dom.cleanup();
  }
});

domTest("audit policy Escape asks before discarding changes and cancel keeps them", async () => {
  const dom = createDomTestHarness();
  const { openAuditPolicyDialog } = await import("./AuditPolicyDialog");
  const { dialogCore } = await import("@k2b/ui");
  try {
    void openAuditPolicyDialog({ tableName: "Loans", fields: [], value: {} });
    const checkbox = dom.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    checkbox.click();
    dom.document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
    await Bun.sleep(5);
    expect(dom.document.body.textContent).toContain("Discard");
    const cancel = Array.from(dom.document.querySelectorAll("button")).filter((button) => button.textContent?.trim() === "Cancel");
    cancel.at(-1)!.click();
    await Bun.sleep(5);
    expect(checkbox.checked).toBe(true);
    expect(dom.document.querySelectorAll("dialog").length).toBe(1);
  } finally {
    dialogCore.close();
    dom.cleanup();
  }
});

domTest("federated config load failure offers retry and disables draft writes", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json({ message: "Temporarily unavailable" }, { status: 503 }), {
    preconnect: originalFetch.preconnect,
  });
  const { openFederatedTableDialog } = await import("./FederatedTableDialog");
  const { dialogCore } = await import("@k2b/ui");
  try {
    void openFederatedTableDialog({ tableId: "TABLE1", tableName: "Combined loans", targetFields: [] });
    await Bun.sleep(20);
    expect(dom.document.body.textContent).toContain("Temporarily unavailable");
    const buttons = Array.from(dom.document.querySelectorAll("button"));
    expect(buttons.some((button) => button.textContent?.trim() === "Retry")).toBe(true);
    expect(buttons.find((button) => button.textContent?.trim() === "Save draft")?.disabled).toBe(true);
    expect(dom.document.querySelectorAll("dialog").length).toBe(1);
  } finally {
    dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("federated draft is frozen during save and its failure stays inline", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let finish: ((response: Response) => void) | undefined;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT")
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      if (String(input).includes("source-candidates")) return Response.json({ items: [], total: 0 });
      return Response.json({ current: null, draft: { revisionToken: "draft-token", sources: [], mappings: [], diagnostics: [] } });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { openFederatedTableDialog } = await import("./FederatedTableDialog");
  const { dialogCore } = await import("@k2b/ui");
  try {
    void openFederatedTableDialog({ tableId: "TABLE1", tableName: "Combined loans", targetFields: [] });
    await Bun.sleep(20);
    Array.from(dom.document.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Save draft")!
      .click();
    await Bun.sleep(5);
    expect(dom.document.querySelector("fieldset")?.disabled).toBe(true);
    finish!(Response.json({ message: "Draft could not be saved" }, { status: 503 }));
    await Bun.sleep(10);
    expect(dom.document.querySelector("fieldset")?.disabled).toBe(false);
    expect(dom.document.body.textContent).toContain("Draft could not be saved");
    expect(dom.document.querySelectorAll(".k2b-panel-dialog-viewport").length).toBe(1);
  } finally {
    dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("template manager distinguishes failure from empty and prevents duplicate requests", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let loadFails = true;
  let posts = 0;
  let finish: ((response: Response) => void) | undefined;
  const template = {
    id: "TMPL01",
    tableId: "TABLE1",
    name: "Loan PDF",
    description: null,
    renderer: { kind: "html", body: "<p>Loan</p>", numberTemplate: "{{ document.sequence }}", filenameTemplate: "loan.pdf" },
    source: "from table Loans",
    enabled: true,
    position: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    numberSeries: null,
  };
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts++;
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      return loadFails ? Response.json({ message: "Temporarily unavailable" }, { status: 503 }) : Response.json([template]);
    },
    { preconnect: originalFetch.preconnect },
  );
  const { openDocumentTemplatesDialog } = await import("./DocumentTemplatesManagerDialog");
  const { dialogCore } = await import("@k2b/ui");
  try {
    void openDocumentTemplatesDialog({ baseId: "BASE01", tableId: "TABLE1", tableName: "Loans" });
    await Bun.sleep(20);
    expect(dom.document.body.textContent).toContain("Temporarily unavailable");
    expect(dom.document.body.textContent).not.toContain("No document templates");
    loadFails = false;
    Array.from(dom.document.querySelectorAll("button"))
      .find((item) => item.textContent?.trim() === "Retry")!
      .click();
    await Bun.sleep(15);
    const duplicate = dom.document.querySelector<HTMLButtonElement>('button[aria-label="Duplicate template"]')!;
    duplicate.click();
    duplicate.click();
    await Bun.sleep(5);
    expect(posts).toBe(1);
    expect(duplicate.disabled).toBe(true);
    finish!(Response.json(template));
    await Bun.sleep(15);
  } finally {
    dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("template editor validates inline and freezes its draft during save", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let saves = 0;
  let finish: ((response: Response) => void) | undefined;
  const template = {
    id: "TMPL01",
    tableId: "TABLE1",
    name: "Loan PDF",
    description: null,
    renderer: { kind: "html" as const, body: "<p>Loan</p>", numberTemplate: "{{ document.sequence }}", filenameTemplate: "loan.pdf" },
    source: "from table Loans where record.id = '{{ record.id }}'",
    enabled: false,
    position: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    numberSeries: null,
  };
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        saves++;
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      return Response.json([]);
    },
    { preconnect: originalFetch.preconnect },
  );
  const { openDocumentTemplateEditorDialog } = await import("./DocumentTemplateEditorDialog");
  const { dialogCore } = await import("@k2b/ui");
  try {
    void openDocumentTemplateEditorDialog({ baseId: "BASE01", tableId: "TABLE1", tableName: "Loans", template });
    await Bun.sleep(15);
    const name = Array.from(dom.document.querySelectorAll<HTMLInputElement>("input")).find((input) => input.value === "Loan PDF")!;
    const save = () =>
      Array.from(dom.document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Save template")!;
    name.value = "";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    save().click();
    await Bun.sleep(10);
    expect(saves).toBe(0);
    expect(dom.document.body.textContent).toContain("Name is required");
    expect(dom.document.activeElement).toBe(name);
    expect(dom.document.querySelectorAll(".k2b-panel-dialog-viewport").length).toBe(1);
    name.value = "Updated loan PDF";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    save().click();
    await Bun.sleep(10);
    expect(saves).toBe(1);
    expect(name.closest("fieldset")?.disabled).toBe(true);
    dom.document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
    await Bun.sleep(5);
    expect(dialogCore.isOpen()).toBe(true);
    finish!(Response.json({ message: "Could not save right now" }, { status: 503 }));
    await Bun.sleep(15);
    expect(name.value).toBe("Updated loan PDF");
    expect(name.closest("fieldset")?.disabled).toBe(false);
    expect(dom.document.body.textContent).toContain("Could not save right now");
    expect(dom.document.querySelectorAll(".k2b-panel-dialog-viewport").length).toBe(1);
  } finally {
    dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
