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
const ben = entry("4", "Ben Albers", "read");
const key = entry("3", "Launch API keys", "admin", {
  principal: { type: "service_account", serviceAccountId: "20000000-0000-4000-8000-000000000003" },
  serviceAccountKind: "resource_bound",
});

let stored: AccessEntry[] = [];
const revoked: string[] = [];
const updated: string[] = [];
// Set to hold the next list read, and to answer it with a failure.
const reads: { held: PromiseWithResolvers<void> | null; fail: boolean } = { held: null, fail: false };
if (!isServer) {
  mock.module("@/api/client", () => ({
    apiClient: {
      ":id": {
        access: {
          $get: async () => {
            const held = reads.held;
            if (held) await held.promise;
            return reads.fail ? Response.json({ message: "Offline" }, { status: 503 }) : Response.json(stored);
          },
          ":accessId": {
            $patch: async ({ param, json }: { param: { accessId: string }; json: { permission: AccessEntry["permission"] } }) => {
              updated.push(`${param.accessId} ${json.permission}`);
              stored = stored.map((item) => (item.id === param.accessId ? { ...item, permission: json.permission } : item));
              return Response.json({ updated: true });
            },
            $delete: async ({ param }: { param: { accessId: string } }) => {
              if (param.accessId === ben.id) return Response.json({ message: "Offline" }, { status: 503 });
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

  const setup = async () => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    delegateEvents(["click", "input"], dom.document);
    const { prompts } = await import("@k2b/ui");
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    const error = spyOn(prompts, "error").mockResolvedValue(undefined);
    const changed = mock(() => {});
    const { PermissionsSection } = await import("../src/frontend/[id]/_components/edit/AccessSection");
    const dispose = render(
      () =>
        createComponent(PermissionsSection, { spaceId: "Space1", spaceName: "Launch", accessEntries: stored, onWorkspaceChange: changed }),
      dom.root,
    );
    const button = (text: string) =>
      Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === text);
    const dialog = () => dom.document.querySelector<HTMLElement>('[role="dialog"]:not(.k2b-avatar-stack__popover)');
    const row = (name: string) => Array.from(dialog()!.querySelectorAll("li")).find((item) => item.textContent?.includes(name))!;
    let disposed = false;
    const disposeSection = () => {
      if (disposed) return;
      disposed = true;
      dispose();
    };
    const cleanup = () => {
      disposeSection();
      confirm.mockRestore();
      error.mockRestore();
      reads.held = null;
      reads.fail = false;
      dom.cleanup();
      revoked.length = 0;
      updated.length = 0;
    };
    return { dom, confirm, error, changed, button, dialog, row, disposeSection, cleanup };
  };

  test("Edit access opens the dialog without API keys; a saved removal shows in the list", async () => {
    stored = [mia, lea, key];
    const { dom, confirm, changed, button, dialog, cleanup } = await setup();
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
      cleanup();
    }
  });

  test("a save that fails halfway and is discarded still shows what was saved", async () => {
    stored = [mia, lea, ben];
    const { dom, changed, button, dialog, row, cleanup } = await setup();
    try {
      button("Edit access")!.click();
      await waitFor(() => dialog()?.textContent?.includes("Ben Albers") === true, "the access dialog");
      Array.from(row("Lea Schmitt").querySelectorAll<HTMLElement>('[role="option"]'))
        .find((option) => option.textContent?.includes("Edit"))!
        .click();
      row("Ben Albers").querySelector<HTMLButtonElement>('button[aria-label="Remove Ben Albers"]')!.click();
      await waitFor(() => dialog()?.textContent?.includes("2 changes") === true, "two changes");
      button("Save")!.click();
      await waitFor(() => !!dialog()?.querySelector('[role="alert"]'), "the failed removal");
      expect(updated).toEqual([`${lea.id} write`]);
      button("Cancel")!.click();
      await waitFor(() => changed.mock.calls.length === 1, "the saved change to reach the workspace");
      await waitFor(() => !dialog(), "the dialog to close");
      await waitFor(() => dom.root.textContent?.replace("Edit access", "").includes("Edit") === true, "the list to show Lea's new level");
      expect(dom.root.textContent).toContain("Ben Albers");
    } finally {
      cleanup();
    }
  });

  test("a reload that fails after the settings closed says nothing over the next page", async () => {
    stored = [mia, lea];
    const { error, button, dialog, disposeSection, cleanup } = await setup();
    try {
      button("Edit access")!.click();
      await waitFor(() => dialog()?.textContent?.includes("Lea Schmitt") === true, "the access dialog");
      dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Remove Lea Schmitt"]')!.click();
      await waitFor(() => dialog()?.textContent?.includes("Will be removed") === true, "the removal mark");
      const held = Promise.withResolvers<void>();
      reads.held = held;
      reads.fail = true;
      button("Save")!.click();
      await waitFor(() => revoked.length === 1 && !dialog(), "the saved removal");
      disposeSection();
      held.resolve();
      await Bun.sleep(30);
      expect(error).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
