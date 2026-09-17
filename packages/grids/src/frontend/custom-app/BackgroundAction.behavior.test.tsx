import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;

domTest("accepted document work stays nonblocking and recovers its result on focus", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      return Response.json(
        init?.method === "POST"
          ? { status: "running" }
          : { status: "ready", document: { id: "DOC001", number: "RE-001", blockId: "identity" }, downloadUrl: "/document.pdf" },
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  const { default: BackgroundAction } = await import("./BackgroundAction");
  let otherClicks = 0;
  const dispose = render(
    () =>
      createComponent(BackgroundAction, {
        label: "Issue invoice",
        endpoint: "/action",
        acceptedMessage: "Creation requested; you can keep working.",
        state: { status: "draft" },
      }),
    dom.root,
  );
  const otherButton = dom.document.createElement("button");
  otherButton.textContent = "Other work";
  otherButton.onclick = () => {
    otherClicks++;
  };
  dom.root.append(otherButton);
  try {
    const issue = dom.root.querySelector("button")!;
    issue.click();
    issue.click();
    await Bun.sleep(10);
    expect(calls).toEqual(["POST"]);
    expect(issue.disabled).toBe(true);
    expect(dom.root.textContent).toContain("Creation requested; you can keep working.");
    dom.root.querySelectorAll("button")[1]!.click();
    expect(otherClicks).toBe(1);
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await Bun.sleep(10);
    expect(calls).toEqual(["POST", "GET"]);
    expect(dom.root.querySelector('a[href="/document.pdf"]')?.textContent).toContain("RE-001");
    dispose();
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await Bun.sleep(10);
    expect(calls).toEqual(["POST", "GET"]);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("document work keeps its editor locked across acceptance and uncertain status until a definitive failure", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let status = "running";
  let unavailable = false;
  let pending = false;
  let completed = 0;
  globalThis.fetch = Object.assign(
    async () => {
      if (unavailable) throw new TypeError("Disconnected");
      return Response.json({ status });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { default: BackgroundAction } = await import("./BackgroundAction");
  const dispose = render(
    () =>
      createComponent(BackgroundAction, {
        label: "Issue invoice",
        endpoint: "/action",
        acceptedMessage: "Requested",
        state: { status: "draft" },
        onPendingChange: (value) => {
          pending = value;
        },
        onCompleted: () => {
          completed++;
        },
      }),
    dom.root,
  );
  try {
    expect(pending).toBe(false);
    dom.root.querySelector("button")!.click();
    expect(pending).toBe(true);
    await Bun.sleep(5);
    expect(pending).toBe(true);
    unavailable = true;
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await Bun.sleep(5);
    expect(pending).toBe(true);
    unavailable = false;
    status = "failed";
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await Bun.sleep(5);
    expect(pending).toBe(false);
    expect(completed).toBe(0);
    status = "running";
    dom.root.querySelector("button")!.click();
    await Bun.sleep(5);
    status = "ready";
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await Bun.sleep(5);
    expect(pending).toBe(true);
    expect(completed).toBe(1);
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await Bun.sleep(5);
    expect(completed).toBe(1);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("a ready initial snapshot does not request another completion reload", async () => {
  const dom = createDomTestHarness();
  const { default: BackgroundAction } = await import("./BackgroundAction");
  let completed = 0;
  const dispose = render(
    () =>
      createComponent(BackgroundAction, {
        label: "Issue invoice",
        endpoint: "/action",
        acceptedMessage: "Requested",
        state: { status: "ready" },
        onCompleted: () => {
          completed++;
        },
      }),
    dom.root,
  );
  try {
    expect(completed).toBe(0);
  } finally {
    dispose();
    dom.cleanup();
  }
});

domTest("an ambiguous start stays locked until a status refresh proves no workflow is active", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let pending = false;
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") throw new TypeError("Reply lost");
      return Response.json({ status: "draft" });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { default: BackgroundAction } = await import("./BackgroundAction");
  const dispose = render(
    () =>
      createComponent(BackgroundAction, {
        label: "Issue invoice",
        endpoint: "/action",
        acceptedMessage: "Requested",
        state: { status: "draft" },
        onPendingChange: (value) => {
          pending = value;
        },
      }),
    dom.root,
  );
  try {
    dom.root.querySelector("button")!.click();
    await Bun.sleep(5);
    expect(pending).toBe(true);
    expect(dom.root.querySelector("button")!.disabled).toBe(false);
    dom.root.querySelector("button")!.click();
    await Bun.sleep(5);
    expect(pending).toBe(false);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("definitive validation rejection shows its message and releases the draft without a status loop", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let pending = false;
  const calls: string[] = [];
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      return Response.json({ message: "Please enter a due date." }, { status: 400 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { default: BackgroundAction } = await import("./BackgroundAction");
  const dispose = render(
    () =>
      createComponent(BackgroundAction, {
        label: "Issue invoice",
        endpoint: "/action",
        acceptedMessage: "Requested",
        state: { status: "draft", finalized: false },
        onPendingChange: (value) => {
          pending = value;
        },
      }),
    dom.root,
  );
  try {
    dom.root.querySelector("button")!.click();
    await Bun.sleep(5);
    expect(pending).toBe(false);
    expect(dom.root.querySelector('[role="alert"]')?.textContent).toContain("Please enter a due date.");
    expect(dom.root.textContent).not.toContain("Check workflow status");
    dom.root.querySelector("button")!.click();
    await Bun.sleep(5);
    expect(calls).toEqual(["POST", "POST"]);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("retrying a finalized failed document skips the obsolete freeze confirmation", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(
    async () => {
      calls++;
      return Response.json({ status: "running", finalized: true });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { default: BackgroundAction } = await import("./BackgroundAction");
  const dispose = render(
    () =>
      createComponent(BackgroundAction, {
        label: "Issue invoice",
        endpoint: "/action",
        confirm: "Freeze this record?",
        acceptedMessage: "Requested",
        state: { status: "failed", finalized: true, message: "PDF rendering failed." },
      }),
    dom.root,
  );
  try {
    expect(dom.root.querySelector('[role="alert"]')?.textContent).toContain("PDF rendering failed.");
    dom.root.querySelector("button")!.click();
    await Bun.sleep(5);
    expect(calls).toBe(1);
    expect(dom.document.body.textContent).not.toContain("Freeze this record?");
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("HTTP 408 stays uncertain and preserves the operation key after a safe status check", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const operations: string[] = [];
  let pending = false;
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        operations.push(JSON.parse(String(init.body)).operationId);
        return Response.json({ message: "Private upstream timeout detail" }, { status: 408 });
      }
      return Response.json({ status: "draft", finalized: false });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { default: BackgroundAction } = await import("./BackgroundAction");
  const dispose = render(
    () =>
      createComponent(BackgroundAction, {
        label: "Issue invoice",
        endpoint: "/action",
        acceptedMessage: "Requested",
        state: { status: "draft" },
        onPendingChange: (value) => {
          pending = value;
        },
      }),
    dom.root,
  );
  try {
    dom.root.querySelector("button")!.click();
    await Bun.sleep(5);
    expect(pending).toBe(true);
    expect(dom.root.textContent).not.toContain("Private upstream");
    dom.root.querySelector("button")!.click();
    await Bun.sleep(5);
    expect(pending).toBe(false);
    dom.root.querySelector("button")!.click();
    await Bun.sleep(5);
    expect(operations).toHaveLength(2);
    expect(operations[1]).toBe(operations[0]);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
