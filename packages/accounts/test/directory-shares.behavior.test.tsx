import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

const accountId = "11111111-1111-4111-8111-111111111111";
const personId = "22222222-2222-4222-8222-222222222222";
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const waitOptions = async () => {
  await new Promise((resolve) => setTimeout(resolve, 250));
  await flush();
};

describe("directory share administration", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => cleanup());
  test("shares a named entry, retains a failed change for retry, then revokes it", async () => {
    const dom = createDomTestHarness();
    const requests: string[] = [];
    let granted = false;
    let failGrant = true;
    const network = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      requests.push(`${method} ${url.pathname}`);
      if (url.pathname.endsWith("/service-accounts"))
        return Response.json({ items: [{ id: accountId, name: "Release helper", kind: "agent" }] });
      if (url.pathname.endsWith("/entities"))
        return Response.json({
          items: [{ id: personId, kind: "user", user: { id: personId, uid: "ada", displayName: "Ada Example", avatarHash: null } }],
        });
      if (url.pathname.includes("/directory-shares/")) {
        if (method === "POST") {
          if (failGrant) return Response.json({ message: "Temporary failure" }, { status: 503 });
          granted = true;
          return Response.json({ id: "share-one" }, { status: 201 });
        }
        if (method === "DELETE") {
          granted = false;
          return Response.json({ ok: true });
        }
        return Response.json({
          items: granted
            ? [{ id: "share-one", label: "Ada Example", principal: { type: "user", userId: personId }, serviceAccountKind: null }]
            : [],
          total: granted ? 1 : 0,
          page: 1,
          perPage: 20,
        });
      }
      throw new Error(`Unexpected request ${method} ${url.pathname}`);
    });
    const { DirectorySharesDialog } = await import("../src/frontend/service-accounts/DirectoryShares.island");
    const dispose = render(() => createComponent(DirectorySharesDialog, { close: () => {}, setDismissHandler: () => {} }), dom.root);
    cleanup = () => {
      dispose();
      network.mockRestore();
      dom.cleanup();
    };
    const input = () => dom.document.querySelectorAll<HTMLInputElement>('input[role="combobox"]');
    const type = async (field: HTMLInputElement, value: string) => {
      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await waitOptions();
    };
    const option = (label: string) =>
      [...dom.document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((node) => node.textContent?.includes(label));
    await type(input()[0]!, "Release");
    expect(option("Release helper")).toBeDefined();
    option("Release helper")!.click();
    await flush();
    expect(dom.root.textContent).toContain("No entries shared");
    await type(input()[1]!, "Ada");
    option("Ada Example")!.click();
    await flush();
    expect(dom.root.textContent).toContain("Could not update directory access");
    expect(dom.root.textContent).toContain("Release helper");
    failGrant = false;
    [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === "Retry")!.click();
    await flush();
    expect(dom.root.textContent).toContain("Ada Example");
    const revoke = dom.root.querySelector<HTMLButtonElement>('button[aria-label="Revoke directory access: Ada Example"]');
    expect(revoke).not.toBeNull();
    revoke!.click();
    await flush();
    expect(dom.root.textContent).toContain("No entries shared");
    expect(requests.filter((request) => request.startsWith("POST "))).toHaveLength(2);
    expect(requests.filter((request) => request.startsWith("DELETE "))).toHaveLength(1);
  });
});
