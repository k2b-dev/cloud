import { describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { DEFAULT_LINUX_IDENTITY_CONFIGURATION } from "@valentinkolb/cloud/contracts";
import type { PosixCandidate } from "@valentinkolb/cloud/services";

const user = (id: string, uid: string): PosixCandidate => ({
  id,
  uid,
  displayName: uid,
  provider: "local",
  profile: "user",
  state: "ready",
  identity: null,
});
const alice = user("11111111-1111-4111-8111-111111111111", "alice");
const bob = user("22222222-2222-4222-8222-222222222222", "bob");
const until = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error("UI did not settle");
};

describe("Linux setup interactions", () => {
  if (isServer) {
    test.skip("run with browser conditions and the Solid DOM preload", () => {});
    return;
  }
  test("reveals defaults only after setup and requires a reserved range", async () => {
    const dom = createDomTestHarness();
    const { default: Panel } = await import("./LinuxIdentityPanel.island.tsx");
    const requests = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () => {
          throw new Error("No request expected");
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const dispose = render(
      () => createComponent(Panel, { initial: { config: DEFAULT_LINUX_IDENTITY_CONFIGURATION, items: [alice], nextCursor: null } }),
      dom.root,
    );
    try {
      expect(dom.root.textContent).not.toContain("Home directory template");
      Array.from(dom.root.querySelectorAll("button"))
        .find((button) => button.textContent === "Set up local identities")!
        .click();
      expect(dom.root.textContent).toContain("Home directory template");
      const save = Array.from(dom.root.querySelectorAll("button")).find((button) => button.textContent === "Check and save setup");
      expect(save?.disabled).toBe(true);
      expect(dom.root.textContent).toContain("I have reserved this range for Cloud");
      expect(requests).not.toHaveBeenCalled();
    } finally {
      dispose();
      requests.mockRestore();
      dom.cleanup();
    }
  });
  test("stops after the in-flight account and refreshes canonical state", async () => {
    const dom = createDomTestHarness();
    const { default: Panel } = await import("./LinuxIdentityPanel.island.tsx");
    const { prompts } = await import("@k2b/ui");
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    const initial = {
      config: { ...DEFAULT_LINUX_IDENTITY_CONFIGURATION, enabled: true, rangeStart: 200000, rangeEnd: 200100 },
      items: [alice, bob],
      nextCursor: null,
    };
    const state = structuredClone(initial);
    const posted: string[] = [];
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const path = new URL(String(input), "http://localhost").pathname;
          if (init?.method === "POST") {
            posted.push(path);
            await pending;
            state.items[0] = {
              ...alice,
              state: "prepared",
              identity: {
                userId: alice.id,
                managedBy: "local",
                uidNumber: 200000,
                primaryGidNumber: 200000,
                homeDirectory: "/home/alice",
                loginShell: "/bin/bash",
              },
            };
            return Response.json(state.items[0]);
          }
          return Response.json(state);
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const dispose = render(() => createComponent(Panel, { initial }), dom.root);
    const button = (label: string) => Array.from(dom.root.querySelectorAll("button")).find((item) => item.textContent === label);
    try {
      button("Select eligible accounts on this page")!.click();
      button("Prepare 2 selected accounts")!.click();
      await until(() => posted.length === 1);
      button("Stop after current account")!.click();
      release();
      await until(() => dom.root.textContent?.includes("Stopped.") === true);
      await until(() => dom.root.textContent?.includes("Identity prepared") === true);
      expect(posted).toHaveLength(1);
      expect(dom.root.textContent).toContain("1 of 2 accounts prepared");
      expect(dom.root.textContent).toContain("Prepare 1 selected account");
      expect(confirm).toHaveBeenCalledTimes(1);
    } finally {
      release();
      dispose();
      requests.mockRestore();
      confirm.mockRestore();
      dom.cleanup();
    }
  });
});
