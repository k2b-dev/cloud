import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as navigation from "@k2b/ssr/nav";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

const created: unknown[] = [];
let lostAnswer = false;
const revoked: string[] = [];
if (!isServer) {
  mock.module("@k2b/cloud/clients/core", () => ({
    coreClient: {
      admin: {
        identity: {
          "service-accounts": {
            ":id": {
              "api-keys": {
                $post: async (payload: unknown) => {
                  created.push(payload);
                  if (lostAnswer) throw new Error("Connection lost");
                  return Response.json({ token: "fictional-new-key", credential: { id: "new" } }, { status: 201 });
                },
              },
            },
          },
        },
      },
    },
  }));
  mock.module("@/api/client", () => ({
    apiClient: {
      "service-accounts": {
        credentials: {
          ":id": {
            $delete: async ({ param }: { param: { id: string } }) => {
              revoked.push(param.id);
              return Response.json({ revoked: true });
            },
          },
        },
      },
    },
  }));
}

const waitFor = async (condition: () => boolean, label: string) => {
  for (let count = 0; count < 200; count++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};
const button = (doc: Document, text: string) =>
  [...doc.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text);

describe("replacing an agent's legacy, limited API key", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    created.length = 0;
    revoked.length = 0;
    lostAnswer = false;
  });

  const setup = async (replace?: { serviceAccountId: string }) => {
    const dom = createDomTestHarness();
    const swapped = spyOn(navigation, "swapPage").mockResolvedValue();
    const { default: Actions } = await import("../src/frontend/service-accounts/ServiceAccountCredentialActions.island");
    const dispose = render(() => createComponent(Actions, { credentialId: "old", name: "CI import", replace }), dom.root);
    cleanup = () => {
      dispose();
      swapped.mockRestore();
      dom.cleanup();
    };
    return { dom, swapped };
  };

  test("only a legacy key offers Replace", async () => {
    const { dom } = await setup();
    expect(button(dom.document, "Replace")).toBeUndefined();
  });

  test("Replace creates a full key, shows it once, and revokes the old key only on request", async () => {
    const { dom, swapped } = await setup({ serviceAccountId: "agent-id" });
    button(dom.document, "Replace")!.click();
    await waitFor(() => !!button(dom.document, "Create new API key"), "the replace dialog");
    expect(created).toEqual([]);
    button(dom.document, "Create new API key")!.click();
    await waitFor(() => dom.document.body.textContent?.includes("fictional-new-key") === true, "the new key");
    expect(created).toEqual([{ param: { id: "agent-id" }, json: { name: "CI import", access: "full", expiresAt: null } }]);
    expect(revoked).toEqual([]);
    button(dom.document, "Revoke old key")!.click();
    await waitFor(() => revoked.length === 1, "the old key's revocation");
    expect(revoked).toEqual(["old"]);
    await waitFor(() => swapped.mock.calls.length === 1, "the list to show the change");
  });

  test("Later keeps both keys and shows the new one in the list", async () => {
    const { dom, swapped } = await setup({ serviceAccountId: "agent-id" });
    button(dom.document, "Replace")!.click();
    await waitFor(() => !!button(dom.document, "Create new API key"), "the replace dialog");
    button(dom.document, "Create new API key")!.click();
    await waitFor(() => !!button(dom.document, "Later"), "the new key");
    button(dom.document, "Later")!.click();
    await waitFor(() => swapped.mock.calls.length === 1, "the list to show the new key");
    expect(revoked).toEqual([]);
  });

  test("the new key takes focus, and a lost answer never offers a second key", async () => {
    const { dom, swapped } = await setup({ serviceAccountId: "agent-id" });
    button(dom.document, "Replace")!.click();
    await waitFor(() => !!button(dom.document, "Create new API key"), "the replace dialog");
    lostAnswer = true;
    button(dom.document, "Create new API key")!.click();
    await waitFor(() => dom.document.body.textContent?.includes("may exist") === true, "the uncertain notice");
    expect(button(dom.document, "Create new API key")!.disabled).toBe(true);
    button(dom.document, "Cancel")!.click();
    // The key may exist, so the list is shown again.
    await waitFor(() => swapped.mock.calls.length === 1, "the list to show what exists");
    expect(created).toHaveLength(1);
  });

  test("after creation focus moves to Copy and the new key is announced", async () => {
    const { dom } = await setup({ serviceAccountId: "agent-id" });
    button(dom.document, "Replace")!.click();
    await waitFor(() => !!button(dom.document, "Create new API key"), "the replace dialog");
    button(dom.document, "Create new API key")!.click();
    await waitFor(() => dom.document.activeElement?.textContent?.includes("Copy API key") === true, "focus on Copy");
    expect(dom.document.querySelector('[role="status"]')?.textContent).toContain("New API key created");
  });
});
