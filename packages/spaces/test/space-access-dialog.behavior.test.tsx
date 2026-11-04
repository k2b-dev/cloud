import { describe, expect, mock, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import type { AccessEntry } from "@/contracts";
import { createDomTestHarness } from "../../ui/test/dom";

const entry = (id: string, name: string, permission: AccessEntry["permission"], extra: Partial<AccessEntry> = {}): AccessEntry => ({
  id: `00000000-0000-4000-8000-00000000000${id}`,
  principal: { type: "user", userId: `10000000-0000-4000-8000-00000000000${id}` },
  permission,
  createdAt: "2026-11-03T00:00:00.000Z",
  displayName: name,
  ...extra,
});
const mia = entry("1", "Mia Hoffmann", "admin");
const lea = entry("2", "Lea Schmitt", "read");
const key = entry("3", "Launch API keys", "admin", {
  principal: { type: "service_account", serviceAccountId: "20000000-0000-4000-8000-000000000003" },
  serviceAccountKind: "resource_bound",
});

let stored: AccessEntry[] = [];
const revoked: string[] = [];
if (!isServer) {
  mock.module("@/api/client", () => ({
    apiClient: {
      ":id": {
        access: {
          $get: async () => Response.json(stored),
          ":accessId": {
            $delete: async ({ param }: { param: { accessId: string } }) => {
              revoked.push(param.accessId);
              stored = stored.filter((item) => item.id !== param.accessId);
              return Response.json({ revoked: true });
            },
          },
        },
      },
    },
  }));
}

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

describe("Spaces settings: access", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("Edit access opens the dialog without API keys; a saved removal shows in the list", async () => {
    stored = [mia, lea, key];
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    delegateEvents(["click", "input"], dom.document);
    const { prompts } = await import("@k2b/ui");
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    const changed = mock(() => {});
    const { PermissionsSection } = await import("../src/frontend/[id]/_components/edit/AccessSection");
    const dispose = render(
      () =>
        createComponent(PermissionsSection, { spaceId: "Space1", spaceName: "Launch", accessEntries: stored, onWorkspaceChange: changed }),
      dom.root,
    );
    const button = (text: string) =>
      Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === text);
    const dialog = () => dom.document.querySelector<HTMLElement>('[role="dialog"]');
    try {
      expect(dom.root.textContent).toContain("Lea Schmitt");
      button("Edit access")!.click();
      await waitFor(() => dialog()?.textContent?.includes("Lea Schmitt") === true, "the access dialog");
      expect(dialog()!.textContent).not.toContain("Launch API keys");
      dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Remove Lea Schmitt"]')!.click();
      await waitFor(() => dialog()?.textContent?.includes("Will be removed") === true, "the removal mark");
      expect(revoked).toEqual([]);
      button("Save")!.click();
      await waitFor(() => !dom.root.textContent?.includes("Lea Schmitt"), "the list to show the saved change");
      expect(revoked).toEqual([lea.id]);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(dom.root.textContent).toContain("Mia Hoffmann");
    } finally {
      dispose();
      confirm.mockRestore();
      dom.cleanup();
    }
  });
});
