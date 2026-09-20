import { afterEach, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

const calls: unknown[] = [];
let status = 403;
mock.module("../src/frontend/public-client", () => ({
  publicClient: {
    ":kind": {
      ":token": {
        api: {
          unlock: {
            $post: async (input: unknown) => {
              calls.push(input);
              return new Response("{}", { status });
            },
          },
        },
      },
    },
  },
}));
let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  calls.length = 0;
  status = 403;
});
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
test("unlock uses a masked input, a JSON body and a useful rate-limit error", async () => {
  const dom = createDomTestHarness();
  const { default: Unlock } = await import("../src/frontend/PublicShareUnlock.island");
  const dispose = render(() => createComponent(Unlock, { token: "public-token", kind: "inbox" }), dom.root);
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  const input = dom.root.querySelector("input")!;
  expect(input.type).toBe("password");
  input.value = "share secret";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  dom.root.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await flush();
  expect(calls[0]).toEqual({ param: { kind: "inbox", token: "public-token" }, json: { password: "share secret" } });
  expect(dom.root.querySelector('[role="alert"]')?.textContent).toContain("password");
  expect(input.value).toBe("");
  status = 429;
  input.value = "share secret";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  dom.root.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await flush();
  expect(dom.root.querySelector('[role="alert"]')?.textContent).toContain("minute");
});
