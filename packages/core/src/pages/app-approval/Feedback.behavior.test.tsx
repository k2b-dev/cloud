import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

if (isServer) {
  test.skip("requires browser conditions and DOM preload", () => {});
} else {
  test("approval feedback preserves the return action without forcing a credential", async () => {
    const dom = createDomTestHarness();
    const navigate = spyOn(dom.window.location, "assign").mockImplementation(() => {});
    const { ApprovalError } = await import("./client");
    const { default: Feedback } = await import("./Feedback");
    const dispose = render(
      () =>
        createComponent(Feedback, {
          error: new ApprovalError("REAUTHENTICATE", 403),
          returnTo: "/me/security?tab=devices",
        }),
      dom.root,
    );
    try {
      dom.root.querySelector<HTMLButtonElement>("button")!.click();
      const url = new URL(String(navigate.mock.calls[0]![0]), "http://localhost");
      expect(url.pathname).toBe("/auth/login");
      expect(url.searchParams.has("credential")).toBe(false);
      expect(url.searchParams.get("redirectTo")).toBe("/me/security?tab=devices&reauthenticate=1");
    } finally {
      navigate.mockRestore();
      dispose();
      dom.cleanup();
    }
  });
}
