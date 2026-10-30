import { describe, expect, spyOn, test } from "bun:test";
import { settingsSaveControls } from "@k2b/cloud/ssr/settings-draft";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

const props = {
  values: { servers: ["nats://system"], kind: "creds", ca: "" },
  unreadable: { servers: false, kind: false, access: false, ca: false },
};
const settled = async () => {
  for (let i = 0; i < 100 && settingsSaveControls()?.state === "saving"; i++) await Bun.sleep(10);
  expect(settingsSaveControls()?.state).not.toBe("saving");
};

describe("NATS diagnostics access form", () => {
  if (isServer) {
    test.skip("requires browser conditions and Solid DOM preload", () => {});
    return;
  }
  test("pasted credentials retain newlines, are submitted once, and clear after saving", async () => {
    const dom = createDomTestHarness();
    const { default: NatsAccessForm } = await import("./NatsAccessForm.island");
    const requests: { url: string; body: unknown }[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
          return Response.json({ success: true });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const dispose = render(() => createComponent(NatsAccessForm, props), dom.root);
    try {
      const input = dom.root.querySelectorAll("textarea")[0]!;
      expect(input.value).toBe("");
      const content = "-----BEGIN NATS USER JWT-----\nfixture\n------END NATS USER JWT------";
      input.value = content;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(settingsSaveControls()?.state).toBe("draft");
      settingsSaveControls()?.save();
      await settled();
      expect(requests).toEqual([
        { url: "/api/gateway/settings/gateway.nats_admin_access", body: { value: content, replaceUnreadable: false } },
      ]);
      expect(input.value).toBe("");
      expect(settingsSaveControls()?.state).toBe("saved");
      const clear = dom.root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      clear.click();
      settingsSaveControls()?.save();
      await settled();
      expect(requests.at(-1)).toEqual({
        url: "/api/gateway/settings/gateway.nats_admin_access",
        body: { value: "", replaceUnreadable: false },
      });
      expect(clear.checked).toBe(false);
    } finally {
      dispose();
      fetch.mockRestore();
      dom.cleanup();
    }
  });
  test("a refused later field keeps the draft and retries only unconfirmed changes", async () => {
    const dom = createDomTestHarness();
    const { default: NatsAccessForm } = await import("./NatsAccessForm.island");
    const requests: string[] = [];
    let refuse = true;
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: RequestInfo | URL) => {
          const url = String(input);
          requests.push(url);
          return refuse && url.endsWith("tls_ca")
            ? Response.json({ message: "Invalid PEM" }, { status: 400 })
            : Response.json({ success: true });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const dispose = render(() => createComponent(NatsAccessForm, props), dom.root);
    try {
      const [access, ca] = dom.root.querySelectorAll("textarea");
      access!.value = "replacement\ncredentials";
      access!.dispatchEvent(new Event("input", { bubbles: true }));
      ca!.value = "invalid PEM";
      ca!.dispatchEvent(new Event("input", { bubbles: true }));
      settingsSaveControls()?.save();
      await settled();
      expect(settingsSaveControls()?.state).toBe("failed");
      expect(dom.root.textContent).toContain("Invalid PEM");
      expect(access!.value).toBe("replacement\ncredentials");
      refuse = false;
      ca!.value = "corrected PEM";
      ca!.dispatchEvent(new Event("input", { bubbles: true }));
      settingsSaveControls()?.save();
      await settled();
      expect(requests.filter((url) => url.endsWith("admin_access"))).toHaveLength(1);
      expect(requests.filter((url) => url.endsWith("tls_ca"))).toHaveLength(2);
      expect(access!.value).toBe("");
      expect(settingsSaveControls()?.state).toBe("saved");
    } finally {
      dispose();
      fetch.mockRestore();
      dom.cleanup();
    }
  });
  test("an uncertain response stays visible and prevents repeating the write", async () => {
    const dom = createDomTestHarness();
    const { default: NatsAccessForm } = await import("./NatsAccessForm.island");
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () => {
          throw new Error("Connection lost");
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const dispose = render(() => createComponent(NatsAccessForm, props), dom.root);
    try {
      const input = dom.root.querySelectorAll("textarea")[0]!;
      input.value = "replacement";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      settingsSaveControls()?.save();
      await settled();
      expect(settingsSaveControls()?.state).toBe("unknown");
      expect(dom.root.textContent).toContain("The connection broke while saving.");
      expect(dom.root.textContent).toContain("Check current state");
      expect(input.value).toBe("replacement");
      settingsSaveControls()?.save();
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
      fetch.mockRestore();
      dom.cleanup();
    }
  });
  test("changing servers requires re-entry and saves the endpoint before replacement access", async () => {
    const dom = createDomTestHarness();
    const { default: NatsAccessForm } = await import("./NatsAccessForm.island");
    const requests: { url: string; body: unknown }[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
          return Response.json({ success: true });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const dispose = render(() => createComponent(NatsAccessForm, props), dom.root);
    try {
      const servers = dom.root.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!;
      servers.value = "nats://replacement";
      servers.dispatchEvent(new Event("input", { bubbles: true }));
      servers.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(
        Array.from(dom.root.querySelectorAll('span[aria-hidden="false"]')).some((node) =>
          node.textContent?.includes("Enter system access for the current server list."),
        ),
      ).toBe(true);
      settingsSaveControls()?.save();
      await settled();
      expect(requests).toHaveLength(0);
      const access = dom.root.querySelectorAll("textarea")[0]!;
      access.value = "replacement access";
      access.dispatchEvent(new Event("input", { bubbles: true }));
      settingsSaveControls()?.save();
      await settled();
      expect(requests.map((request) => request.url)).toEqual([
        "/api/gateway/settings/gateway.nats_admin_servers",
        "/api/gateway/settings/gateway.nats_admin_access",
      ]);
      expect(requests[0]?.body).toEqual({ value: ["nats://replacement"], replaceUnreadable: false });
      expect(requests[1]?.body).toEqual({ value: "replacement access", replaceUnreadable: false });
      expect(access.value).toBe("");
    } finally {
      dispose();
      fetch.mockRestore();
      dom.cleanup();
    }
  });

  test("access re-entry remains visible after reloading a changed endpoint", async () => {
    const dom = createDomTestHarness();
    const { default: NatsAccessForm } = await import("./NatsAccessForm.island");
    const dispose = render(() => createComponent(NatsAccessForm, { ...props, accessRequired: true }), dom.root);
    try {
      expect(
        Array.from(dom.root.querySelectorAll('span[aria-hidden="false"]')).some((node) =>
          node.textContent?.includes("Enter system access for the current server list."),
        ),
      ).toBe(true);
      expect(dom.root.querySelectorAll("textarea")[0]!.value).toBe("");
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});
