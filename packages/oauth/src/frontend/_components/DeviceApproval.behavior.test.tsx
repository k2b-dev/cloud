import { describe, expect, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { DeviceApprovalView } from "./DeviceApproval";

const confirm: DeviceApprovalView = {
  kind: "confirm",
  request: "11111111-1111-4111-8111-111111111111",
  code: "WDJB-MJHT",
  client: { name: "Cloud CLI", clientId: "cloud-cli" },
  scopes: ["openid", "read", "write", "offline_access"],
};

const mount = async (locale: string, view: DeviceApprovalView) => {
  const dom = createDomTestHarness();
  delegateEvents(["click", "input"], dom.document);
  const { LocaleProvider } = await import("@k2b/ui");
  const { DeviceApproval } = await import("./DeviceApproval");
  const dispose = render(
    () => (
      <LocaleProvider locale={locale}>
        <DeviceApproval view={view} />
      </LocaleProvider>
    ),
    dom.root,
  );
  return {
    root: dom.root,
    close: () => {
      dispose();
      dom.cleanup();
    },
  };
};

const buttons = (root: HTMLElement) => Array.from(root.querySelectorAll("button")).map((node) => node.textContent?.trim());

describe("device approval page DOM", () => {
  if (isServer) {
    test.skip("requires --conditions=browser and packages/ui/test/solid-dom-preload.ts", () => {});
    return;
  }

  test("code entry formats what the person types into XXXX-XXXX and submits it as user_code", async () => {
    const page = await mount("en", { kind: "entry" });
    try {
      expect(page.root.querySelector("h1")?.textContent).toBe("Connect a device");
      const form = page.root.querySelector("form");
      expect(form?.getAttribute("method")).toBe("get");
      expect(form?.getAttribute("action")).toBe("/oauth/device");
      const input = page.root.querySelector<HTMLInputElement>('input[name="user_code"]');
      if (!input) throw new Error("Code input missing");
      input.value = "wdjb mjht0";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(input.value).toBe("WDJB-MJHT");
      expect(buttons(page.root)).toContain("Continue");
    } finally {
      page.close();
    }
  });

  test("an invalid code keeps the typed value and explains the error in German", async () => {
    const page = await mount("de", { kind: "entry", code: "AAAA-AAAA", error: "Dieser Code ist ungültig oder abgelaufen." });
    try {
      expect(page.root.querySelector("h1")?.textContent).toBe("Gerät verbinden");
      expect(page.root.querySelector<HTMLInputElement>('input[name="user_code"]')?.value).toBe("AAAA-AAAA");
      expect(page.root.textContent).toContain("Dieser Code ist ungültig oder abgelaufen.");
      expect(buttons(page.root)).toContain("Weiter");
    } finally {
      page.close();
    }
  });

  test("confirmation names the client, the code, every scope, and the own-code warning in English", async () => {
    const page = await mount("en", confirm);
    try {
      expect(page.root.querySelector("h1")?.textContent).toBe("Allow Cloud CLI to access your account?");
      expect(page.root.querySelector('[data-testid="device-user-code"]')?.textContent).toBe("WDJB-MJHT");
      expect(page.root.textContent).toContain("cloud-cli");
      expect(page.root.textContent).toContain("Perform changes available to your account");
      expect(page.root.textContent).toContain("Stay connected until you revoke access");
      expect(page.root.textContent).toContain("Only continue if you started this sign-in yourself.");
      const form = page.root.querySelector("form");
      expect(form?.getAttribute("method")).toBe("post");
      expect(page.root.querySelector<HTMLInputElement>('input[name="request"]')?.value).toBe(confirm.request);
      expect(buttons(page.root)).toEqual(["Deny", "Allow access"]);
      expect(Array.from(page.root.querySelectorAll("button")).map((node) => node.getAttribute("value"))).toEqual(["deny", "approve"]);
    } finally {
      page.close();
    }
  });

  test("confirmation and outcomes read naturally in German", async () => {
    const page = await mount("de", confirm);
    try {
      expect(page.root.querySelector("h1")?.textContent).toBe("Cloud CLI Zugriff auf dein Konto erlauben?");
      expect(page.root.textContent).toContain("Für dein Konto verfügbare Änderungen ausführen");
      expect(page.root.textContent).toContain("Fahre nur fort, wenn du diese Anmeldung selbst gestartet hast.");
      expect(buttons(page.root)).toEqual(["Ablehnen", "Zugriff erlauben"]);
    } finally {
      page.close();
    }

    const approved = await mount("de", { kind: "result", outcome: "approved" });
    try {
      expect(approved.root.querySelector("h1")?.textContent).toBe("Gerät verbunden");
    } finally {
      approved.close();
    }
    const denied = await mount("en", { kind: "result", outcome: "denied" });
    try {
      expect(denied.root.querySelector("h1")?.textContent).toBe("Access denied");
      expect(denied.root.querySelector("form")).toBeNull();
    } finally {
      denied.close();
    }
  });
});
