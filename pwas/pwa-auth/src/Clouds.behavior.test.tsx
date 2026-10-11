import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../packages/ui/test/dom";
import type { Authenticator, Login } from "./authenticator";
import type { Preferences } from "./preferences";
import type { Binding } from "./storage";

test("login requests use the shared sheet and dismiss without approving", async () => {
  const dom = createDomTestHarness();
  const { Clouds } = await import("./Clouds");
  const { closeDialogs } = await import("./dialog");
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const binding: Binding = {
    id: "fixture",
    label: "Test Cloud",
    name: "Test",
    issuer: "http://localhost",
    deviceId: "device",
    key: { privateKey: keys.privateKey, publicKey: { kty: "EC", crv: "P-256", x: "unused", y: "unused" } },
  };
  const request: Login = {
    requestId: "login",
    comparison: "123456",
    challenge: "unused",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const [requests, setRequests] = createSignal([request]);
  const decisions: string[] = [];
  const noop = async () => {};
  const auth: Authenticator = {
    bindings: () => [binding],
    states: () => ({ fixture: { requests: requests(), actions: [], moreActions: 0 } }),
    now: Date.now,
    online: () => true,
    storageError: () => false,
    changed: noop,
    client: async () => {
      throw new Error("No network in this test");
    },
    stored: async () => undefined,
    account: async () => {
      throw new Error("No network in this test");
    },
    action: async () => {
      throw new Error("No action in this test");
    },
    act: noop,
    decide: async (_binding, _request, decision) => {
      decisions.push(decision);
      setRequests([]);
    },
    revoke: noop,
    syncPush: noop,
    forget: noop,
    rename: noop,
  };
  const preferences: Preferences = {
    locale: () => "en",
    language: () => "en",
    theme: () => "light",
    setLanguage: () => {},
    setTheme: () => {},
  };
  const dispose = render(() => createComponent(Clouds, { auth, preferences }), dom.root);
  try {
    await Bun.sleep(30);
    expect(document.querySelector("dialog.k2b-bottom-sheet-frame")).not.toBeNull();
    expect(document.querySelector("dialog output")?.textContent).toBe("123456");
    document.querySelector<HTMLButtonElement>("dialog .k2b-bottom-sheet__handle")!.click();
    await Bun.sleep(30);
    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(decisions).toEqual([]);
    dom.root.querySelector<HTMLButtonElement>(".auth-request-row button")!.click();
    await Bun.sleep(30);
    const approve = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find((button) =>
      button.textContent?.includes("Approve"),
    )!;
    approve.click();
    await Bun.sleep(30);
    expect(decisions).toEqual(["approve"]);
    expect(document.querySelector("dialog[open]")).toBeNull();
  } finally {
    closeDialogs();
    await Bun.sleep(20);
    dispose();
    dom.cleanup();
  }
});

for (const scenario of ["approve", "deny", "stale", "uncertain", "expired", "load", "digest", "focus", "focus-unknown"] as const) {
  test(`Action review: ${scenario}`, async () => {
    const dom = createDomTestHarness();
    const { Clouds } = await import("./Clouds");
    const { closeDialogs } = await import("./dialog");
    const { AppApprovalClientError, appApproval } = await import("@k2b/cloud/browser/app-approval");
    const binding: Binding = {
      id: "fixture",
      label: "Test Cloud",
      name: "Phone",
      issuer: "https://cloud.example.org",
      deviceId: "device",
      key: await appApproval.createKey(),
    };
    const view: import("./authenticator").ActionView = {
      actionId: "action",
      app: { id: "files", name: "Files" },
      requester: { app: { id: "assistant", name: "Assistant" }, title: "<b>Chat</b>" },
      assurance: "confirm",
      sentence: '<a href="https://evil.example">Remove file</a>',
      message: "<img src=x> Details",
      details: [
        { label: "<b>Name</b>", value: "<script>text</script>" },
        { label: "Date", value: "2026-10-11", format: "date" },
      ],
      truncated: true,
      argsDigest: "input",
      digest: "unused",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const decisions: string[] = [];
    const reads: string[] = [];
    const focusing = scenario === "focus" || scenario === "focus-unknown";
    const [actions, setActions] = createSignal(focusing ? [] : [view]);
    const [now, setNow] = createSignal(Date.now());
    const [focus, setFocus] = createSignal<import("./Clouds").ActionFocus | undefined>(
      focusing ? { actionId: "action", cloud: scenario === "focus" ? binding.issuer : undefined } : undefined,
    );
    const noop = async () => {};
    const auth: Authenticator = {
      bindings: () => [binding],
      states: () => ({ fixture: { requests: [], actions: actions(), moreActions: 2 } }),
      now,
      online: () => true,
      storageError: () => false,
      changed: noop,
      client: async () => {
        throw new Error("not used");
      },
      stored: async () => undefined,
      account: async () => {
        throw new Error("not used");
      },
      decide: noop,
      action: async (_binding, actionId) => {
        reads.push(actionId);
        await Bun.sleep(5);
        if (scenario === "load") throw new Error("load failure");
        if (scenario === "digest") throw new AppApprovalClientError("INVALID_RESPONSE");
        return view;
      },
      act: async (_binding, _view, decision) => {
        decisions.push(decision);
        if (scenario === "stale" || scenario === "uncertain") throw new Error(scenario);
        setActions([]);
      },
      revoke: noop,
      syncPush: noop,
      forget: noop,
      rename: noop,
    };
    const preferences: Preferences = {
      locale: () => "en",
      language: () => "en",
      theme: () => "light",
      setLanguage: () => {},
      setTheme: () => {},
    };
    const dispose = render(
      () => createComponent(Clouds, { auth, preferences, focusAction: focus, actionFocused: () => setFocus(undefined) }),
      dom.root,
    );
    const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("dialog button")];
    const button = (label: string) => buttons().find((item) => item.textContent?.trim() === label)!;
    try {
      if (!focusing) {
        await Bun.sleep(30);
        expect(document.querySelector("dialog[open]")).toBeNull();
        expect(dom.root.textContent).toContain("2 more waiting in Cloud");
        expect(dom.root.querySelector(".auth-action-row")?.textContent).toContain("Files · <a href=");
        dom.root.querySelector<HTMLButtonElement>(".auth-action-row button")!.click();
        // The view loads on the row's button; no sheet opens before it is there.
        await Bun.sleep(0);
        expect(dom.root.querySelector(".auth-action-row button")?.getAttribute("aria-busy")).toBe("true");
        expect(document.querySelector("dialog[open]")).toBeNull();
      }
      await Bun.sleep(40);
      expect(focus()).toBeUndefined();
      if (scenario === "focus-unknown") {
        // Not listed and no Cloud named: nothing to load, and the focus does not linger.
        expect(reads).toEqual([]);
        expect(document.querySelector("dialog[open]")).toBeNull();
        return;
      }
      expect(reads).toEqual(["action"]);
      if (scenario === "load" || scenario === "digest") {
        expect(document.querySelector("dialog[open]")).toBeNull();
        const failed = dom.root.querySelector('.auth-action-row [role="alert"]');
        expect(failed?.textContent).toBe("Could not load. Check it in Cloud.");
        expect(dom.root.querySelector(".auth-action-row time")).toBeNull();
        expect(dom.root.querySelector(".auth-action-row button")?.hasAttribute("aria-busy")).toBe(false);
        return;
      }
      const dialog = document.querySelector("dialog[open]")!;
      // The first frame already shows the whole request.
      expect(dialog.textContent).not.toContain("Loading");
      expect(dialog.querySelector(".auth-action-frame")?.textContent).toContain("Files on cloud.example.org wants to:");
      expect(dialog.textContent).toContain("Requested by Assistant");
      expect(dialog.querySelector("blockquote")?.textContent).toBe(view.sentence);
      expect(dialog.textContent).toContain("<img src=x> Details");
      expect(dialog.querySelector("dl")?.textContent).toContain("Chat<b>Chat</b><b>Name</b><script>text</script>");
      expect(dialog.querySelector("dl")?.textContent).toContain("2026");
      expect(dialog.querySelector("dl")?.textContent).not.toContain("2026-10-11");
      expect(dialog.textContent).toContain("Shortened. See everything in Cloud under My account → Approvals.");
      expect(dialog.textContent).toContain("Asks every time");
      expect(dialog.querySelector(".auth-action-body a, .auth-action-body img, .auth-action-body script")).toBeNull();
      expect(dialog.querySelector(".auth-action-actions")?.hasAttribute("inert")).toBe(true);
      if (scenario === "expired") {
        setNow(Date.parse(view.expiresAt));
        await Bun.sleep(10);
        expect(dialog.querySelector("h3")?.textContent).toBe("Expired");
        expect(dialog.textContent).toContain("This request has expired. Nothing happens.");
        expect(dialog.querySelector("blockquote")).toBeNull();
        expect(decisions).toEqual([]);
        return;
      }
      button("Approve").click();
      expect(decisions).toEqual([]);
      await Bun.sleep(200);
      expect(dialog.querySelector(".auth-action-actions")?.hasAttribute("inert")).toBe(true);
      await Bun.sleep(300);
      expect(dialog.querySelector(".auth-action-actions")?.hasAttribute("inert")).toBe(false);
      const choice = scenario === "deny" ? "Deny" : "Approve";
      button(choice).click();
      button(choice)?.click();
      await Bun.sleep(20);
      expect(decisions).toEqual([scenario === "deny" ? "deny" : "approve"]);
      const titles = { approve: "Approved", focus: "Approved", deny: "Denied", stale: "Not applied", uncertain: "Not confirmed" };
      const texts = {
        approve: "Assistant continues in Cloud.",
        focus: "Assistant continues in Cloud.",
        deny: "Nothing happens.",
        stale: "This request was already decided, has expired or changed. Check it in Cloud.",
        uncertain: "The result could not be confirmed. This request will not be sent again. Check it in Cloud.",
      };
      expect(dialog.querySelector("h3")?.textContent).toBe(titles[scenario]);
      expect(dialog.textContent).toContain(texts[scenario]);
      expect(dialog.querySelector(".auth-action-result")?.getAttribute("role")).toBe(scenario === "uncertain" ? "alert" : "status");
      button("Done").click();
      await Bun.sleep(30);
      expect(document.querySelector("dialog[open]")).toBeNull();
    } finally {
      closeDialogs();
      await Bun.sleep(20);
      dispose();
      dom.cleanup();
    }
  });
}
