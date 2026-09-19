import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { WorkflowPromptSession } from "./WorkflowActionDialog";

const settle = () => Bun.sleep(15);

test("prompt retains its values and operation after ambiguous acceptance and retries without a second confirmation", async () => {
  const dom = createDomTestHarness();
  const { WorkflowActionDialog } = await import("./WorkflowActionDialog");
  const originalFetch = globalThis.fetch;
  const posts: Array<{ operationId: string; inputs: Record<string, unknown> }> = [];
  const session: WorkflowPromptSession = { draft: { amount: "50.00" } };
  const outcomes: unknown[] = [];
  globalThis.fetch = Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        if (posts.length === 1) throw new TypeError("Connection lost after acceptance");
        return Response.json({ statusUrl: "/status" });
      }
      if (String(url) === "/status") return Response.json({ status: "succeeded" });
      return Response.json({ inputs: [{ name: "amount", type: "text", config: { label: "Amount", required: true } }] });
    },
    { preconnect: originalFetch.preconnect },
  );
  const dispose = render(
    () =>
      createComponent(WorkflowActionDialog, {
        action: {
          id: "pay",
          kind: "workflow",
          label: "Record payment",
          endpoint: "/api/grids/apps/runtime/APP001/bill/actions/actions/pay?bill_id=REC001",
          launcherId: "LAUNCH1",
          operationScope: "actor-scope",
          prompt: { inputs: ["amount"], successMessage: "Payment recorded" },
        },
        session,
        close: (outcome) => outcomes.push(outcome),
        setDismissHandler: () => {},
        onOperationChange: () => {},
      }),
    dom.root,
  );
  try {
    await settle();
    const submit = () =>
      Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
        /Record payment|Check status/.test(button.textContent ?? ""),
      )!;
    const trigger = submit();
    trigger.click();
    trigger.click();
    await settle();
    expect(posts).toHaveLength(1);
    expect(outcomes).toHaveLength(0);
    expect(session.operation?.operationId).toBe(posts[0]!.operationId);
    expect(dom.root.querySelector<HTMLInputElement>("input")?.value).toBe("50.00");
    expect(dom.root.querySelector("fieldset")?.disabled).toBe(true);
    submit().click();
    await settle();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(outcomes).toMatchObject([{ kind: "success", message: "Payment recorded" }]);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

test("definitive rejection keeps the draft editable and the dialog open", async () => {
  const dom = createDomTestHarness();
  const { WorkflowActionDialog } = await import("./WorkflowActionDialog");
  const originalFetch = globalThis.fetch;
  const session: WorkflowPromptSession = { draft: { amount: "invalid" } };
  const outcomes: unknown[] = [];
  globalThis.fetch = Object.assign(
    async (_url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json({ message: "Correct the amount" }, { status: 400 })
        : Response.json({ inputs: [{ name: "amount", type: "text", config: { label: "Amount", required: true } }] }),
    { preconnect: originalFetch.preconnect },
  );
  const dispose = render(
    () =>
      createComponent(WorkflowActionDialog, {
        action: {
          id: "pay",
          kind: "workflow",
          label: "Record payment",
          endpoint: "/api/grids/apps/runtime/APP001/bill/actions/actions/pay?bill_id=REC001",
          launcherId: "LAUNCH1",
          operationScope: "actor-scope",
          prompt: { inputs: ["amount"] },
        },
        session,
        close: (outcome) => outcomes.push(outcome),
        setDismissHandler: () => {},
        onOperationChange: () => {},
      }),
    dom.root,
  );
  try {
    await settle();
    Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Record payment")!
      .click();
    await settle();
    expect(outcomes).toHaveLength(0);
    expect(session.operation).toBeUndefined();
    expect(dom.root.querySelector("fieldset")?.disabled).toBe(false);
    expect(dom.root.querySelector<HTMLInputElement>("input")?.value).toBe("invalid");
    expect(dom.root.textContent).toContain("Correct the amount");
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

test("reload resumes the same accepted attempt even when current input metadata has disappeared", async () => {
  const dom = createDomTestHarness();
  const { WorkflowActionDialog } = await import("./WorkflowActionDialog");
  const originalFetch = globalThis.fetch;
  const posts: unknown[] = [];
  let metadataAvailable = true;
  const outcomes: unknown[] = [];
  globalThis.fetch = Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        if (posts.length === 1) throw new TypeError("Response lost");
        return Response.json({ statusUrl: "/api/grids/status" });
      }
      if (String(url) === "/api/grids/status") return Response.json({ status: "succeeded" });
      return metadataAvailable
        ? Response.json({ inputs: [{ name: "amount", type: "text", config: { required: true } }] })
        : Response.json({ message: "Revision changed" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const action = {
    id: "pay",
    kind: "workflow" as const,
    label: "Record payment",
    endpoint: "/api/grids/apps/runtime/APP001/bill/actions/actions/pay?bill_id=REC001",
    launcherId: "LAUNCH1",
    operationScope: "same-actor",
    prompt: { inputs: ["amount"] },
  };
  const mount = (session: WorkflowPromptSession) =>
    render(
      () =>
        createComponent(WorkflowActionDialog, {
          action,
          session,
          close: (result) => outcomes.push(result),
          setDismissHandler: () => {},
          onOperationChange: () => {},
        }),
      dom.root,
    );
  let dispose = mount({ draft: { amount: "50" } });
  try {
    await settle();
    Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Record payment")!
      .click();
    await settle();
    expect(posts).toHaveLength(1);
    dispose();
    metadataAvailable = false;
    action.launcherId = "LAUNCH2";
    const reloaded: WorkflowPromptSession = { draft: {} };
    dispose = mount(reloaded);
    await settle();
    expect(reloaded.submittedInputs).toEqual({ amount: "50" });
    Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Check status")!
      .click();
    await settle();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(outcomes).toMatchObject([{ kind: "success" }]);
    expect(dom.window.sessionStorage.length).toBe(0);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
