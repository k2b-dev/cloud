import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

const settle = () => Bun.sleep(20);
const waitFor = async <T,>(read: () => T | undefined): Promise<T> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(10);
  }
  throw new Error("Expected dialog state did not appear");
};

test("page recovery survives a hidden source action and preserves actor, record, endpoint and exact submission", async () => {
  const dom = createDomTestHarness();
  const { default: WorkflowActionRecovery } = await import("./WorkflowActionRecovery.island");
  const { storeWorkflowPromptAttempt, workflowPromptSessionKey, listWorkflowPromptAttempts } = await import("./workflow-prompt-session");
  const originalFetch = globalThis.fetch;
  const endpoint = "/api/grids/apps/runtime/APP001/bill/payments/actions/receive?bill_id=REC001";
  const operation = { operationId: crypto.randomUUID() };
  const inputs = { amount: "50.00", reference: "private reference" };
  const action = { id: "receive", label: "Record payment", endpoint, launcherId: "LAUNCH1" };
  const posts: Array<{ url: string; body: unknown }> = [];
  let completed = 0;
  storeWorkflowPromptAttempt(workflowPromptSessionKey("actor1", endpoint), action, operation, inputs);
  expect(listWorkflowPromptAttempts("actor2", "/apps/APP001/bill?bill_id=REC001")).toHaveLength(0);
  expect(listWorkflowPromptAttempts("actor1", "/apps/APP001/bill?bill_id=REC002")).toHaveLength(0);
  globalThis.fetch = Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return Response.json({ statusUrl: "/api/grids/accepted-run" });
      }
      return String(url) === "/api/grids/accepted-run"
        ? Response.json({ status: "succeeded" })
        : Response.json({ message: "Hidden action" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const dispose = render(
    () =>
      createComponent(WorkflowActionRecovery, {
        operationScope: "actor1",
        pagePath: "/apps/APP001/bill?bill_id=REC001",
        onCompleted: () => {
          completed++;
        },
      }),
    dom.root,
  );
  try {
    await settle();
    expect(dom.root.textContent).toContain("Check status: Record payment");
    expect(dom.root.textContent).not.toContain("50.00");
    expect(dom.root.textContent).not.toContain("private reference");
    dom.root.querySelector<HTMLButtonElement>("button")!.click();
    const status = await waitFor(() =>
      Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent === "Check status" && !button.disabled,
      ),
    );
    status.click();
    await waitFor(() => (completed === 1 ? true : undefined));
    expect(posts).toEqual([{ url: endpoint, body: { operationId: operation.operationId, inputs, launcherId: "LAUNCH1" } }]);
    expect(completed).toBe(1);
    expect(listWorkflowPromptAttempts("actor1", "/apps/APP001/bill?bill_id=REC001")).toHaveLength(0);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

test("a different prompt on the same page resumes the earlier submission instead of creating a second payment", async () => {
  const dom = createDomTestHarness();
  const { default: Actions } = await import("./Actions");
  const { storeWorkflowPromptAttempt, workflowPromptSessionKey } = await import("./workflow-prompt-session");
  const originalFetch = globalThis.fetch;
  const endpoint = "/api/grids/apps/runtime/APP001/bill/primary/actions/receive?bill_id=REC001";
  const operation = { operationId: crypto.randomUUID() };
  const inputs = { amount: "50" };
  storeWorkflowPromptAttempt(
    workflowPromptSessionKey("actor1", endpoint),
    { id: "old", label: "Original payment", endpoint, launcherId: "LAUNCH1" },
    operation,
    inputs,
  );
  const calls: Array<{ url: string; body: unknown }> = [];
  let completed = 0;
  globalThis.fetch = Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return Response.json({ statusUrl: "/api/grids/status" });
      }
      if (String(url) === "/api/grids/status") return Response.json({ status: "succeeded" });
      return Response.json({ message: "Original action no longer offered" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const dispose = render(
    () =>
      createComponent(Actions, {
        actions: [
          {
            id: "new",
            kind: "workflow",
            label: "Add another payment",
            endpoint: "/api/grids/apps/runtime/APP001/bill/secondary/actions/receive?bill_id=REC001",
            operationScope: "actor1",
            launcherId: "LAUNCH2",
            prompt: { inputs: ["amount"] },
          },
        ],
        onCompleted: () => {
          completed++;
        },
      }),
    dom.root,
  );
  try {
    dom.root.querySelector<HTMLButtonElement>("button")!.click();
    const status = await waitFor(() =>
      Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent === "Check status" && !button.disabled,
      ),
    );
    expect(dom.document.body.textContent).toContain("Original payment");
    status.click();
    await waitFor(() => (completed === 1 ? true : undefined));
    expect(calls).toEqual([{ url: endpoint, body: { inputs, operationId: operation.operationId, launcherId: "LAUNCH1" } }]);
    expect(completed).toBe(1);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
