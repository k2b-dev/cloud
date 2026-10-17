import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../packages/ui/test/dom";
import type { Authenticator, Login } from "./authenticator";
import { authMessages } from "./i18n";
import type { Preferences } from "./preferences";
import type { Binding } from "./storage";

const terminalScopes = ["openid", "profile", "email", "offline_access", "read", "write"];
for (const scenario of [
  { name: "browser", locale: "en" },
  { name: "terminal EN", locale: "en", scopes: terminalScopes },
  { name: "terminal DE", locale: "de", scopes: terminalScopes },
  { name: "terminal with an unknown scope", locale: "en", scopes: ["read", "files:sync"] },
  { name: "terminal with one scope", locale: "en", scopes: ["read"] },
  { name: "queued terminal", locale: "en", scopes: terminalScopes, queued: true },
] as const) {
  test(`${scenario.name} requests show their context, dismiss without approving and approve only once`, async () => {
    const dom = createDomTestHarness();
    const { Clouds } = await import("./Clouds");
    const { closeDialogs } = await import("./dialog");
    const { LocaleProvider } = await import("@k2b/ui");
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const binding: Binding = {
      id: "fixture",
      label: "Test Cloud",
      name: "Test",
      issuer: "https://cloud.example.org:8443",
      deviceId: "device",
      key: { privateKey: keys.privateKey, publicKey: { kty: "EC", crv: "P-256", x: "unused", y: "unused" } },
    };
    const scopes = "scopes" in scenario ? scenario.scopes : undefined;
    const queued = "queued" in scenario;
    const t = authMessages.resolve([scenario.locale]).t;
    const request: Login = {
      requestId: "login",
      comparison: "123456",
      challenge: "unused",
      ...(scopes ? { terminal: { client: { id: "cloud-cli", name: "Cloud CLI" }, scopes: [...scopes], lifetimeSeconds: 28800 } } : {}),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    const [requests, setRequests] = createSignal([request, ...(queued ? [{ ...request, requestId: "next" }] : [])]);
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
        await Bun.sleep(10);
        setRequests([]);
      },
      revoke: noop,
      syncPush: noop,
      forget: noop,
      rename: noop,
    };
    const preferences: Preferences = {
      locale: () => scenario.locale,
      language: () => scenario.locale,
      theme: () => "light",
      setLanguage: () => {},
      setTheme: () => {},
    };
    const dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: preferences.locale(),
          get children() {
            return createComponent(Clouds, { auth, preferences });
          },
        }),
      dom.root,
    );
    try {
      await Bun.sleep(30);
      expect(document.querySelector("dialog.k2b-bottom-sheet-frame")).not.toBeNull();
      const dialog = document.querySelector("dialog[open].is-adaptive")!;
      expect(dialog).not.toBeNull();
      expect(dialog.querySelector("output")?.textContent).toBe("123456");
      const title = scopes ? (scenario.locale === "de" ? "Terminal-Anmeldung (Cloud CLI)" : "Terminal sign-in (Cloud CLI)") : binding.label;
      expect(dialog.querySelector("h2")?.textContent).toBe(title);
      expect([...dom.root.querySelectorAll(".auth-request-row > span")].map((row) => row.textContent)).toEqual(
        Array(queued ? 2 : 1).fill(scopes ? title : "Sign-in request"),
      );
      const context = dialog.querySelector(".auth-decision__request")!;
      expect(context.querySelector("p:not(.auth-decision__started)")?.textContent).toBe(scopes ? t.terminalComparison : t.loginComparison);
      if (scopes) {
        expect(dialog.querySelector(".k2b-panel-dialog__header p")?.textContent).toBe(queued ? `${binding.label} · 1 / 2` : binding.label);
        const labels = [...dialog.querySelectorAll("dl dt")];
        expect(labels.map((label) => label.textContent)).toEqual(
          scenario.locale === "de" ? ["Cloud", "Gültig für", "Berechtigungen"] : ["Cloud", "Valid for", "Permissions"],
        );
        expect(labels[0]?.nextElementSibling?.textContent).toBe("cloud.example.org:8443");
        expect(labels[1]?.nextElementSibling?.textContent).toBe(scenario.locale === "de" ? "8 Stunden" : "8 hours");
        const words: Record<string, string> = {
          openid: t.scopeOpenId,
          profile: t.scopeProfile,
          email: t.scopeEmail,
          offline_access: t.scopeOffline,
          read: t.scopeRead,
          write: t.scopeWrite,
        };
        const permissions = labels[2]?.nextElementSibling;
        if (scopes.length > 1) {
          expect([...permissions!.querySelectorAll("ul > li")].map((item) => item.textContent)).toEqual(
            scopes.map((scope) => words[scope] ?? scope),
          );
        } else {
          expect(permissions?.textContent).toBe(t.scopeRead);
          expect(permissions?.querySelector("ul")).toBeNull();
        }
      } else {
        expect(dialog.querySelector("dl")).toBeNull();
        expect(dialog.querySelector(".k2b-panel-dialog__header p")).toBeNull();
      }
      if (!queued) {
        document.querySelector<HTMLButtonElement>("dialog .k2b-bottom-sheet__handle")!.click();
        await Bun.sleep(30);
        expect(document.querySelector("dialog[open]")).toBeNull();
        expect(decisions).toEqual([]);
        dom.root.querySelector<HTMLButtonElement>(".auth-request-row button")!.click();
        await Bun.sleep(30);
      }
      const approve = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find(
        (button) => button.textContent === t.approve,
      )!;
      approve.click();
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
}

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
