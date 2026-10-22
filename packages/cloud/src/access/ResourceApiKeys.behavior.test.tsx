import { describe, expect, setSystemTime, test } from "bun:test";
import { createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { ResourceApiKey } from "./ResourceApiKeys";

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

describe("ResourceApiKeys caller refreshes", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("creation replaces a key already supplied by the caller in place without duplicating it", async () => {
    const dom = createDomTestHarness();
    setSystemTime(new Date("2026-10-17T12:00:00.000Z"));
    const { default: ResourceApiKeys } = await import("./ResourceApiKeys");
    const credential: ResourceApiKey = {
      id: "00000000-0000-4000-8000-000000000001",
      serviceAccountId: "00000000-0000-4000-8000-000000000002",
      name: "Created key",
      kind: "api_token",
      status: "active",
      tokenPrefix: "test_created",
      scopes: [],
      permission: "read",
      expiresAt: null,
      lastUsedAt: null,
      createdBy: null,
      createdAt: "2026-10-17T12:00:00.000Z",
      revokedAt: null,
      revokedBy: null,
    };
    const existing = { ...credential, id: "00000000-0000-4000-8000-000000000003", name: "Existing key", tokenPrefix: "test_existing" };
    const [keys, setKeys] = createSignal([existing]);
    let finishCreate!: () => void;
    delegateEvents(["click", "input", "submit"], dom.document);
    const dispose = render(
      () => (
        <ResourceApiKeys
          initialKeys={keys()}
          createKey={async () => {
            setKeys([existing, { ...credential, name: "Refetched key" }]);
            await new Promise<void>((resolve) => {
              finishCreate = resolve;
            });
            return { credential, token: "test-token-shown-once" };
          }}
          revokeKey={async () => {}}
        />
      ),
      dom.root,
    );
    const rows = () => Array.from(dom.root.querySelectorAll<HTMLElement>(".group\\/api-key"));
    try {
      dom.root.querySelector<HTMLButtonElement>("button")!.click();
      await waitFor(() => dom.document.querySelector("dialog input") !== null, "the creation dialog");
      const input = dom.document.querySelector<HTMLInputElement>('dialog input[placeholder="e.g. website embed"]')!;
      input.value = credential.name;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      dom.document.querySelector("dialog form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await waitFor(() => typeof finishCreate === "function", "the caller refetch during creation");
      expect(rows().map((row) => row.querySelector(".truncate")?.textContent)).toEqual(["Existing key", "Refetched key"]);
      finishCreate();
      await waitFor(() => dom.document.querySelector("dialog code")?.textContent === "test-token-shown-once", "the success callback");
      expect(rows().filter((row) => row.textContent?.includes(credential.tokenPrefix))).toHaveLength(1);
      expect(rows().map((row) => row.querySelector(".truncate")?.textContent)).toEqual(["Existing key", "Created key"]);
    } finally {
      dom.document.querySelector<HTMLButtonElement>("dialog[open] .k2b-dialog__close")?.click();
      dispose();
      setSystemTime();
      dom.cleanup();
    }
  });
});
