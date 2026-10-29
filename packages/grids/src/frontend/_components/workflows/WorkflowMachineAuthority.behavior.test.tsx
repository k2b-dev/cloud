import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;
const load = async () => {
  const dom = createDomTestHarness();
  try {
    return await import("./WorkflowMachineAuthority");
  } finally {
    dom.cleanup();
  }
};
const component = isServer ? null : await load();
const waitFor = async (read: () => boolean) => {
  for (let n = 0; n < 100; n++) {
    if (read()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected authority UI state did not arrive");
};
const accountId = "11111111-1111-4111-8111-111111111111",
  mandateId = "22222222-2222-4222-8222-222222222222";
domTest("machine authority loads, recovers from failures, pauses and revokes with the current revision", async () => {
  const dom = createDomTestHarness(),
    originalFetch = globalThis.fetch;
  let readFails = true,
    writeFails = false,
    state: "active" | "paused" | "revoked" = "active",
    revision = 1,
    currentMandateId = mandateId;
  const writes: unknown[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
      if (req.method === "PUT") {
        const body = await req.json();
        writes.push(body);
        if (writeFails) {
          // Another administrator assigned a different mandate at the same revision.
          currentMandateId = "33333333-3333-4333-8333-333333333333";
          return Response.json({ message: "Conflict" }, { status: 409 });
        }
        state = body.action === "pause" ? "paused" : body.action === "revoke" ? "revoked" : "active";
        revision++;
      } else if (readFails) return Response.json({ message: "Unavailable" }, { status: 503 });
      return Response.json({
        hasHumanOwner: false,
        serviceAccountId: accountId,
        name: "Nightly inventory",
        kind: "agent",
        accountStatus: "active",
        mandate: { id: currentMandateId, state, revision, permissionCap: "write" },
        canConfigure: true,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  const dispose = render(() => createComponent(component!.WorkflowMachineAuthority, { workflowId: "WORK01" }), dom.root);
  const click = async (label: string) => {
    await waitFor(() => [...dom.root.querySelectorAll("button")].some((b) => b.textContent?.trim() === label));
    [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)!.click();
  };
  try {
    await waitFor(() => dom.root.textContent!.includes("Execution authority could not be loaded"));
    readFails = false;
    await click("Retry");
    await waitFor(() => dom.root.textContent!.includes("Nightly inventory"));
    expect(dom.root.textContent).toContain("Agent");
    expect(dom.root.textContent).toContain("Write ceiling");
    await click("Pause mandate");
    await waitFor(() => dom.root.textContent!.includes("Resume mandate"));
    expect(writes[0]).toEqual({ action: "pause", expected: { serviceAccountId: accountId, mandate: { id: mandateId, revision: 1 } } });
    writeFails = true;
    await click("Revoke mandate");
    await waitFor(() => dom.root.textContent!.includes("Execution authority changed"));
    expect(dom.root.textContent).toContain("Paused");
    writeFails = false;
    await click("Reload authority");
    await waitFor(
      () => ![...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Revoke mandate")!.disabled,
    );
    await click("Revoke mandate");
    await waitFor(() => dom.root.textContent!.includes("Blocked"));
    expect(writes.at(-1)).toEqual({
      action: "revoke",
      expected: { serviceAccountId: accountId, mandate: { id: "33333333-3333-4333-8333-333333333333", revision: 2 } },
    });
    expect(dom.root.textContent).not.toContain("Resume mandate");
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("missing and disabled execution owners stay visibly blocked without granting configuration controls", async () => {
  const dom = createDomTestHarness(),
    originalFetch = globalThis.fetch;
  let missing = false;
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({
        hasHumanOwner: false,
        serviceAccountId: missing ? null : accountId,
        name: missing ? null : "Nightly inventory",
        kind: missing ? null : "agent",
        accountStatus: missing ? null : "disabled",
        mandate: missing ? null : { id: mandateId, state: "active", revision: 1, permissionCap: "write" },
        canConfigure: false,
      }),
    { preconnect: originalFetch.preconnect },
  );
  let dispose = render(() => createComponent(component!.WorkflowMachineAuthority, { workflowId: "WORK01" }), dom.root);
  try {
    await waitFor(() => dom.root.textContent!.includes("Blocked"));
    expect(dom.root.textContent).toContain("An administrator with workflow management rights");
    expect(dom.root.querySelector("input")).toBeNull();
    dispose();
    missing = true;
    dispose = render(() => createComponent(component!.WorkflowMachineAuthority, { workflowId: "WORK02" }), dom.root);
    await waitFor(() => dom.root.textContent!.includes("Execution blocked: the automatic execution owner is unavailable"));
    expect(dom.root.textContent).not.toContain("existing human owner");
    expect(dom.root.querySelector("input")).toBeNull();
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
