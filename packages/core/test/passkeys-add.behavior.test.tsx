import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

let startResult: () => Promise<Response> = async () =>
  Response.json({ code: "REAUTHENTICATE", message: "Sign in again to confirm it is you." }, { status: 403 });
const start = mock(() => startResult());
const startRegistration = mock(async () => ({}));
if (!isServer) {
  mock.module("@k2b/cloud/clients/core", () => ({
    apiClient: { me: { passkeys: { $get: mock(async () => Response.json({ items: [] })), registration: { start: { $post: start } } } } },
  }));
  mock.module("@simplewebauthn/browser", () => ({ browserSupportsWebAuthn: () => true, startRegistration }));
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("adding a passkey with an old sign-in", () => {
  if (isServer) {
    test.skip("requires browser conditions and the DOM preload", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    mock.restore();
    start.mockClear();
    startRegistration.mockClear();
    startResult = async () => Response.json({ code: "REAUTHENTICATE", message: "Sign in again to confirm it is you." }, { status: 403 });
  });

  const mount = async (path: string, draft?: { name: string }) => {
    const dom = createDomTestHarness();
    dom.window.history.replaceState(null, "", path);
    if (draft) dom.window.sessionStorage.setItem("k2b:confirm-identity:add=passkey", JSON.stringify(draft));
    const { prompts } = await import("@k2b/ui");
    const dialog = spyOn(prompts, "dialog").mockResolvedValue({ name: "Laptop" } as never);
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    const error = spyOn(prompts, "error").mockResolvedValue(undefined);
    const assign = spyOn(dom.window.location, "assign").mockImplementation(() => undefined);
    const { default: PasskeysSettings } = await import("../src/pages/me/PasskeysSettings.island");
    const dispose = render(() => createComponent(PasskeysSettings, { initialPasskeys: [] }), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    const add = async () => {
      [...dom.root.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Add")!.click();
      await flush();
    };
    return { dom, dialog, confirm, error, assign, add };
  };

  test("asks to confirm identity before the passkey ceremony and returns to adding it", async () => {
    const view = await mount("/me/security");
    await view.add();
    expect(start).toHaveBeenCalledTimes(1);
    expect(startRegistration).not.toHaveBeenCalled();
    expect(view.error).not.toHaveBeenCalled();
    expect(String(view.confirm.mock.calls[0]?.[0])).toContain("Adding a passkey needs a sign-in from the last 10 minutes.");
    expect(view.confirm.mock.calls[0]?.[1]).toMatchObject({ title: "Confirm identity", confirmText: "Confirm identity" });
    const target = new URL(String(view.assign.mock.calls[0]?.[0]), "http://localhost/");
    expect(target.pathname).toBe("/auth/login");
    expect(target.searchParams.get("redirectTo")).toBe("/me/security?add=passkey&reauthenticate=1");
    expect(view.dom.window.sessionStorage.getItem("k2b:confirm-identity:add=passkey")).toBe(JSON.stringify({ name: "Laptop" }));
  });

  test("cancelling the confirmation stays on the page", async () => {
    const view = await mount("/me/security");
    view.confirm.mockResolvedValue(false);
    await view.add();
    expect(view.assign).not.toHaveBeenCalled();
    expect(view.dom.window.location.pathname).toBe("/me/security");
  });

  test("coming back from the sign-in opens the add dialog once and cleans the address", async () => {
    // A different failure this time, so the dialog result does not store a new draft.
    startResult = async () => Response.json({ code: "INTERNAL" }, { status: 500 });
    const view = await mount("/me/security?add=passkey&reauthenticate=1", { name: "Laptop" });
    await flush();
    expect(view.dialog).toHaveBeenCalledTimes(1);
    expect(view.dom.window.sessionStorage.getItem("k2b:confirm-identity:add=passkey")).toBeNull();
    expect(view.dom.window.location.pathname + view.dom.window.location.search).toBe("/me/security");
  });

  test("another credential is told to add passkeys in the browser", async () => {
    startResult = async () => Response.json({ code: "BROWSER_SIGN_IN_REQUIRED" }, { status: 403 });
    const view = await mount("/me/security");
    await view.add();
    expect(view.confirm).not.toHaveBeenCalled();
    expect(view.error).toHaveBeenCalledWith("Create API keys and passkeys in Cloud in the browser.");
  });
});
