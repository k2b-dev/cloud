import { expect, spyOn, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { FormBlockData } from "../../api/custom-app-published-page";

const domTest = isServer ? test.skip : test;
const data: Extract<FormBlockData, { ok: true }> = {
  ok: true,
  submitUrl: "/runtime/APP001/invoice/payment/submit?invoice_id=BILL01",
  form: { id: "FORM01", name: "Payment", config: { fields: [{ kind: "user_input", fieldId: "FIELD1", required: true }] } },
  fields: [
    {
      id: "FIELD1",
      tableId: "TABLE1",
      name: "Reference",
      type: "text",
      config: {},
      required: true,
      description: null,
      deletedAt: null,
      createdAt: "2026-09-17T00:00:00Z",
      updatedAt: "2026-09-17T00:00:00Z",
      position: 0,
      presentable: false,
      hideInTable: false,
      defaultValue: null,
      indexed: false,
      uniqueConstraint: false,
    },
  ],
  inlineTargetFields: {},
};

domTest("contextual form validates locally, keeps failed saves retryable, and refreshes its origin only after success", async () => {
  const dom = createDomTestHarness();
  const { default: FormDialog } = await import("./FormDialog.island");
  await import("./sidebar-form");
  const { dialogCore } = await import("@k2b/ui");
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: unknown }> = [];
  let respond: ((response: Response) => void) | undefined;
  globalThis.fetch = Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Promise<Response>((resolve) => {
        respond = resolve;
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  const dispose = render(
    () => (
      <FormDialog presentation={{ kind: "dialog", label: "Capture payment" }} data={data} dateConfig={{ locale: "en", timeZone: "UTC" }} />
    ),
    dom.root,
  );
  try {
    expect(dom.document.querySelector("form")).toBeNull();
    const trigger = dom.root.querySelector("button")!;
    expect(trigger.dataset.variant).toBe("secondary");
    trigger.click();
    expect(trigger.getAttribute("aria-busy")).toBe("true");
    expect(trigger.disabled).toBe(true);
    await Bun.sleep(0);
    const form = dom.document.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Bun.sleep(0);
    expect(requests).toHaveLength(0);
    expect(form.textContent).toContain("required");
    const input = form.querySelector("input")!;
    input.value = "Bank transfer";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Bun.sleep(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(data.submitUrl);
    dom.document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
    await Bun.sleep(0);
    expect(dialogCore.isOpen()).toBe(true);
    respond!(Response.json({ error: "Temporarily unavailable" }, { status: 503 }));
    await Bun.sleep(5);
    expect(dialogCore.isOpen()).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Bun.sleep(0);
    expect(requests[1]!.body).toEqual(requests[0]!.body);
    respond!(Response.json({}));
    await Bun.sleep(5);
    expect(dialogCore.isOpen()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    dialogCore.close();
    dispose();
    reload.mockRestore();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("explicit successful navigation takes precedence over refreshing the origin", async () => {
  const dom = createDomTestHarness();
  const { openCustomAppFormDialog } = await import("./sidebar-form");
  const { dialogCore } = await import("@k2b/ui");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json({ navigateTo: "/apps/APP001/payment?payment_id=NEW001" }), {
    preconnect: originalFetch.preconnect,
  });
  const replace = spyOn(window.location, "replace").mockImplementation(() => {});
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  void openCustomAppFormDialog({
    label: "Edit payment",
    data: { ...data, initialRecord: { version: 3, values: { FIELD1: "Existing payment" }, inlineCreates: {} } },
    dateConfig: { locale: "en", timeZone: "UTC" },
  });
  try {
    expect(dom.document.querySelector("input")!.value).toBe("Existing payment");
    dom.document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Bun.sleep(5);
    expect(replace).toHaveBeenCalledWith("/apps/APP001/payment?payment_id=NEW001");
    expect(reload).not.toHaveBeenCalled();
  } finally {
    dialogCore.close();
    replace.mockRestore();
    reload.mockRestore();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("leaving before the dialog module loads does not open an orphan form", async () => {
  const dom = createDomTestHarness();
  const { default: FormDialog } = await import("./FormDialog.island");
  await import("./sidebar-form");
  const { dialogCore } = await import("@k2b/ui");
  const dispose = render(
    () => (
      <FormDialog presentation={{ kind: "dialog", label: "Capture payment" }} data={data} dateConfig={{ locale: "en", timeZone: "UTC" }} />
    ),
    dom.root,
  );
  const trigger = dom.root.querySelector("button")!;
  const focus = spyOn(trigger, "focus");
  trigger.click();
  dispose();
  await Bun.sleep(0);
  try {
    expect(dialogCore.isOpen()).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  } finally {
    focus.mockRestore();
    dialogCore.close();
    dom.cleanup();
  }
});

domTest("dirty dismissal uses the shared confirmation and cancellation preserves entered values", async () => {
  const dom = createDomTestHarness();
  const { openCustomAppFormDialog } = await import("./sidebar-form");
  const { dialogCore, prompts } = await import("@k2b/ui");
  const confirm = spyOn(prompts, "confirm").mockResolvedValue(false);
  void openCustomAppFormDialog({ label: "Capture payment", data, dateConfig: { locale: "en", timeZone: "UTC" } });
  try {
    const input = dom.document.querySelector("input")!;
    input.value = "Keep my reference";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const dialog = dom.document.querySelector("dialog")!;
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    await Bun.sleep(0);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(dialogCore.isOpen()).toBe(true);
    expect(input.value).toBe("Keep my reference");
    confirm.mockResolvedValue(true);
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    await Bun.sleep(0);
    expect(dialogCore.isOpen()).toBe(false);
  } finally {
    dialogCore.close();
    confirm.mockRestore();
    dom.cleanup();
  }
});

domTest("the main form action uses its explicitly configured primary hierarchy", async () => {
  const dom = createDomTestHarness();
  const { default: FormDialog } = await import("./FormDialog.island");
  const dispose = render(
    () => (
      <FormDialog
        presentation={{ kind: "dialog", label: "Capture payment", variant: "primary" }}
        data={data}
        dateConfig={{ locale: "en", timeZone: "UTC" }}
      />
    ),
    dom.root,
  );
  try {
    const trigger = dom.root.querySelector("button")!;
    expect(trigger.dataset.variant).toBe("primary");
    expect(trigger.textContent).toBe("Capture payment");
    expect(dom.document.querySelector("form")).toBeNull();
  } finally {
    dispose();
    dom.cleanup();
  }
});

domTest("closing the lazy form restores its trigger after loading has blurred it", async () => {
  const dom = createDomTestHarness();
  const { default: FormDialog } = await import("./FormDialog.island");
  await import("./sidebar-form");
  const { dialogCore } = await import("@k2b/ui");
  const dispose = render(
    () => (
      <FormDialog presentation={{ kind: "dialog", label: "Capture payment" }} data={data} dateConfig={{ locale: "en", timeZone: "UTC" }} />
    ),
    dom.root,
  );
  try {
    const trigger = dom.root.querySelector("button")!;
    trigger.focus();
    trigger.click();
    expect(trigger.disabled).toBe(true);
    // Native browsers blur disabled focused buttons; Happy DOM does not.
    dom.document.body.tabIndex = -1;
    dom.document.body.focus();
    expect(dom.document.activeElement === dom.document.body).toBe(true);
    await Bun.sleep(5);
    const dialog = dom.document.querySelector("dialog")!;
    dialog.querySelector("input")!.focus();
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    await Bun.sleep(30);
    expect(dialogCore.isOpen()).toBe(false);
    expect(dom.document.activeElement === trigger).toBe(true);
  } finally {
    dialogCore.close();
    dispose();
    dom.cleanup();
  }
});

domTest("a failed dialog opening restores the enabled trigger", async () => {
  const dom = createDomTestHarness();
  const { default: FormDialog } = await import("./FormDialog.island");
  const forms = await import("./sidebar-form");
  const { toast } = await import("@k2b/ui");
  const open = spyOn(forms, "openCustomAppFormDialog").mockRejectedValue(new Error("Unavailable"));
  const error = spyOn(toast, "error").mockImplementation(() => ({ dismiss() {}, update() {} }));
  const dispose = render(
    () => (
      <FormDialog presentation={{ kind: "dialog", label: "Capture payment" }} data={data} dateConfig={{ locale: "en", timeZone: "UTC" }} />
    ),
    dom.root,
  );
  try {
    const trigger = dom.root.querySelector("button")!;
    trigger.focus();
    trigger.click();
    dom.document.body.tabIndex = -1;
    dom.document.body.focus();
    await Bun.sleep(5);
    expect(error).toHaveBeenCalledTimes(1);
    expect(trigger.disabled).toBe(false);
    expect(dom.document.activeElement === trigger).toBe(true);
  } finally {
    dispose();
    open.mockRestore();
    error.mockRestore();
    dom.cleanup();
  }
});
