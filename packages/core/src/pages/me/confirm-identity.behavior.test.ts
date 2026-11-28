import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

// "Confirm identity" before new access (a passkey, an API key, an SSH key): ask once, keep the draft in this tab, sign
// in again, and come back to the page that opens its dialog once with the draft. The question is v2's `confirm`.
const asked: { title: string; description?: string; confirm: string }[] = [];
let answer = true;
if (!isServer)
  mock.module("@k2b/ui/v2", () => ({
    confirm: async (options: { title: string; description?: string; confirm: string }) => {
      asked.push(options);
      return answer;
    },
  }));

describe("confirm identity", () => {
  if (isServer) {
    test.skip("requires browser conditions and the DOM preload", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    asked.length = 0;
    answer = true;
  });
  const mount = (path: string) => {
    const dom = createDomTestHarness();
    dom.window.history.replaceState(null, "", path);
    const assign = spyOn(dom.window.location, "assign").mockImplementation(() => undefined);
    cleanup = () => dom.cleanup();
    return { dom, assign };
  };

  test("asks once, keeps the draft in this tab and signs in again with the way back to the dialog", async () => {
    const { dom, assign } = mount("/me/security");
    const { confirmIdentity } = await import("./confirm-identity");
    await confirmIdentity(
      "Adding a passkey needs a recent sign-in.",
      { key: "add", value: "passkey" },
      { title: "Confirm identity", confirm: "Confirm identity" },
      { name: "Laptop" },
    );
    expect(asked).toEqual([
      { title: "Confirm identity", description: "Adding a passkey needs a recent sign-in.", confirm: "Confirm identity" },
    ]);
    const target = new URL(String(assign.mock.calls[0]?.[0]), "http://localhost/");
    expect(target.pathname).toBe("/auth/login");
    expect(target.searchParams.get("redirectTo")).toBe("/me/security?add=passkey&reauthenticate=1");
    expect(dom.window.sessionStorage.getItem("k2b:confirm-identity:add=passkey")).toBe(JSON.stringify({ name: "Laptop" }));
  });

  test("a no keeps the person on the page and stores nothing", async () => {
    answer = false;
    const { dom, assign } = mount("/me/developer");
    const { confirmIdentity } = await import("./confirm-identity");
    await confirmIdentity(
      "…",
      { key: "create", value: "api-key" },
      { title: "Confirm identity", confirm: "Confirm identity" },
      { name: "CI" },
    );
    expect(assign).not.toHaveBeenCalled();
    expect(dom.window.sessionStorage.getItem("k2b:confirm-identity:create=api-key")).toBeNull();
  });

  test("coming back takes the draft once and cleans the address, so a reload opens nothing", async () => {
    const { dom } = mount("/me/security?add=passkey&reauthenticate=1#top");
    dom.window.sessionStorage.setItem("k2b:confirm-identity:add=passkey", JSON.stringify({ name: "Laptop" }));
    const { takeReturnIntent } = await import("./confirm-identity");
    expect(takeReturnIntent({ key: "add", value: "passkey" })).toEqual({ draft: { name: "Laptop" } });
    expect(dom.window.location.pathname + dom.window.location.search + dom.window.location.hash).toBe("/me/security#top");
    expect(dom.window.sessionStorage.getItem("k2b:confirm-identity:add=passkey")).toBeNull();
    expect(takeReturnIntent({ key: "add", value: "passkey" })).toBeNull();
  });
});
