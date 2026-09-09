import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { PublicWorkflow } from "../workspace/workspace-public-state-model";

const domTest = isServer ? test.skip : test;
const workflow: PublicWorkflow = {
  id: "WORK01",
  baseId: "BASE01",
  name: "Inventory",
  description: null,
  source: "",
  enabled: true,
  position: 0,
  revision: 1,
  ownerUserId: null,
  deletedAt: null,
  diagnostics: [],
  createdAt: "2026-09-09T12:00:00Z",
  updatedAt: "2026-09-09T12:00:00Z",
  plan: {
    schemaVersion: 2,
    languageId: "grids",
    languageVersion: 1,
    sourceHash: "a".repeat(64),
    manifestHash: "a".repeat(64),
    catalogHash: "a".repeat(64),
    actionPolicies: {},
    bindings: {},
    steps: [],
    triggers: [],
    inputs: [{ name: "code", type: "text", config: { required: true } }],
  },
};

domTest("workflow creation first asks for a starter instead of showing all configuration forms", async () => {
  const dom = createDomTestHarness();
  const { render } = await import("solid-js/web");
  const { dialogCore } = await import("@k2b/ui");
  const { createWorkflowAction } = await import("../sidebar/create-workflow");
  const dispose = render(() => {
    const open = createWorkflowAction({ baseId: "BASE01", tables: [], fieldsByTable: {} });
    const button = dom.document.createElement("button");
    button.textContent = "Open workflow";
    button.addEventListener("click", () => void open());
    return button;
  }, dom.root);
  try {
    dom.root.querySelector("button")!.click();
    await Bun.sleep(30);
    expect(dom.document.body.textContent).toContain("Blank workflow");
    expect(dom.document.querySelectorAll('[role="combobox"]').length).toBe(0);
    const choice = Array.from(dom.document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Close selected Records"),
    );
    choice!.click();
    await Bun.sleep(30);
    expect(dom.document.body.textContent).toContain("Choose another starter");
    expect(dom.document.body.textContent).not.toContain("Blank workflow");
  } finally {
    dialogCore.close();
    dispose();
    dom.cleanup();
  }
});

domTest("email template load failures stay inline and provide retry", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let fail = true;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) =>
      fail
        ? Response.json({ message: "Cannot reach template service" }, { status: 503 })
        : Response.json(String(input).includes("dependencies") ? {} : []),
    { preconnect: originalFetch.preconnect },
  );
  const { render } = await import("solid-js/web");
  const { EmailTemplateManager } = await import("./WorkflowEmailTemplates");
  const dispose = render(() => <EmailTemplateManager baseId="BASE01" onChanged={() => {}} onClose={() => {}} />, dom.root);
  try {
    await Bun.sleep(30);
    expect(dom.document.body.textContent).toContain("Cannot reach template service");
    expect(dom.document.querySelectorAll("dialog").length).toBe(0);
    fail = false;
    Array.from(dom.document.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Retry")!
      .click();
    await Bun.sleep(30);
    expect(dom.document.body.textContent).not.toContain("Cannot reach template service");
    expect(dom.document.body.textContent).toContain("No email templates");
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("launcher preserves entered configuration on save failure and retries before closing", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let writes = 0;
  let finish: (() => void) | undefined;
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "POST") return Response.json({ items: [] });
      writes++;
      if (writes === 1) return Response.json({ message: "Please retry this save" }, { status: 503 });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return Response.json({
        ...JSON.parse(String(init.body)),
        id: "LAUN01",
        baseId: workflow.baseId,
        workflowId: workflow.id,
        validatedRevision: 1,
        diagnostics: [],
        deletedAt: null,
        createdAt: workflow.createdAt,
        updatedAt: workflow.updatedAt,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { render } = await import("solid-js/web");
  const { dialogCore } = await import("@k2b/ui");
  const { WorkflowLauncherManager } = await import("./WorkflowLauncherManager");
  const dispose = render(
    () => <WorkflowLauncherManager workflow={workflow} tables={[]} onChanged={() => {}} onClose={() => {}} />,
    dom.root,
  );
  const buttons = (label: string) =>
    Array.from(dom.document.querySelectorAll("button")).filter((button) => button.textContent?.trim() === label);
  try {
    await Bun.sleep(30);
    buttons("Add run option")[0]!.click();
    await Bun.sleep(30);
    const name = dom.document.querySelector<HTMLInputElement>("input")!;
    name.value = "Scan inventory";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    buttons("Add run option").at(-1)!.click();
    await Bun.sleep(30);
    expect(writes).toBe(1);
    expect(dom.document.body.textContent).toContain("Please retry this save");
    expect(name.value).toBe("Scan inventory");
    buttons("Cancel").at(-1)!.click();
    await Bun.sleep(30);
    expect(dom.document.body.textContent).toContain("Unsaved changes");
    buttons("Cancel").at(-1)!.click();
    await Bun.sleep(30);
    expect(name.value).toBe("Scan inventory");
    buttons("Add run option").at(-1)!.click();
    await Bun.sleep(30);
    expect(writes).toBe(2);
    expect(dom.document.querySelector("input")).not.toBeNull();
    dom.document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dom.document.querySelector("input")).not.toBeNull();
    finish!();
    await Bun.sleep(40);
    expect(dom.document.querySelector("input")).toBeNull();
  } finally {
    dialogCore.close();
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
