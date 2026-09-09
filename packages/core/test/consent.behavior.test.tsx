import { afterEach, describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

const accept = mock(async (_input: unknown) => new Response(null, { status: 204 }));
const logout = mock(async () => new Response(null, { status: 204 }));
if (!isServer)
  mock.module("@k2b/cloud/clients/core", () => ({
    apiClient: {
      auth: {
        "legal-consent": { $post: accept },
        logout: { $post: logout },
      },
    },
  }));
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

describe("explicit first-login acceptance", () => {
  if (isServer) {
    test.skip("requires browser conditions and DOM preload", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    accept.mockClear();
    logout.mockClear();
  });
  const mount = async () => {
    const dom = createDomTestHarness();
    const { default: Consent } = await import("../src/pages/auth/ConsentForm.island");
    const dispose = render(() => createComponent(Consent, { version: "a".repeat(64), redirectTo: "/app/contacts" }), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    return dom;
  };
  test("does not preselect or submit acceptance and sends the displayed version only on explicit confirmation", async () => {
    const dom = await mount();
    const checkbox = dom.root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const submit = dom.root.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(checkbox.checked).toBe(false);
    expect(submit.disabled).toBe(true);
    expect(accept).not.toHaveBeenCalled();
    checkbox.click();
    expect(submit.disabled).toBe(false);
    submit.click();
    await flush();
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept.mock.calls[0]?.[0]).toEqual({ json: { accepted: true, version: "a".repeat(64) } });
    expect(dom.window.location.pathname).toBe("/app/contacts");
  });
  test("changed documents require a reload; cancellation remains possible", async () => {
    accept.mockImplementationOnce(async () => new Response(null, { status: 409 }));
    const dom = await mount();
    dom.root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    dom.root.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await flush();
    expect(dom.root.textContent).toContain("documents have changed");
    expect(dom.root.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    Array.from(dom.root.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Cancel and sign out"))!
      .click();
    await flush();
    expect(logout).toHaveBeenCalledTimes(1);
    expect(dom.window.location.pathname).toBe("/auth/login");
  });
  test("network failure retains the choice and permits a retry without showing success", async () => {
    accept.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    const dom = await mount();
    dom.root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    dom.root.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await flush();
    expect(dom.root.textContent).toContain("offline");
    expect(dom.root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    expect(dom.root.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  });
});
