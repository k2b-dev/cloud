import { describe, expect, mock, spyOn, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { AccessEntry } from "../contracts/shared";

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const user = (id: string, name: string, permission: AccessEntry["permission"]): AccessEntry => ({
  id: `00000000-0000-4000-8000-00000000000${id}`,
  principal: { type: "user", userId: `10000000-0000-4000-8000-00000000000${id}` },
  permission,
  createdAt: "2026-11-03T00:00:00.000Z",
  displayName: name,
});
const mia = user("1", "Mia Hoffmann", "admin");
const lea = user("2", "Lea Schmitt", "read");
const bot: AccessEntry = {
  id: "00000000-0000-4000-8000-000000000003",
  principal: { type: "service_account", serviceAccountId: "20000000-0000-4000-8000-000000000003" },
  permission: "write",
  createdAt: "2026-11-03T00:00:00.000Z",
  displayName: "Lagerbot",
  serviceAccountKind: "agent",
};

describe("AccessDialog", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const setup = async (overrides: { updateAccess?: () => Promise<void> } = {}) => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    delegateEvents(["click", "input"], dom.document);
    const { AccessDialog } = await import("./AccessDialog");
    const { prompts } = await import("@k2b/ui");
    const calls: string[] = [];
    const close = mock((_saved: boolean) => {});
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    const dispose = render(
      () => (
        <AccessDialog
          resourceName="Einkauf 2027"
          initialEntries={[mia, lea, bot]}
          viewerUserId={mia.principal.type === "user" ? mia.principal.userId : undefined}
          grantAccess={async (principal, permission) => {
            calls.push(`grant ${principal.type} ${permission}`);
            return { id: "00000000-0000-4000-8000-000000000009", principal, permission, createdAt: "now" };
          }}
          updateAccess={
            overrides.updateAccess ??
            (async (id, permission) => {
              calls.push(`update ${id.slice(-1)} ${permission}`);
            })
          }
          revokeAccess={async (id) => {
            calls.push(`revoke ${id.slice(-1)}`);
          }}
          close={close}
        />
      ),
      dom.root,
    );
    const row = (name: string) => Array.from(dom.root.querySelectorAll("li")).find((item) => item.textContent?.includes(name))!;
    const button = (text: string) =>
      Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === text)!;
    const choose = (name: string, level: string) =>
      Array.from(row(name).querySelectorAll<HTMLElement>('[role="option"]'))
        .find((option) => option.textContent?.includes(level))!
        .click();
    return {
      dom,
      calls,
      close,
      confirm,
      row,
      button,
      choose,
      cleanup: () => {
        dispose();
        confirm.mockRestore();
        dom.cleanup();
      },
    };
  };

  test("nothing applies before Save; What changes lists each change; Save asks once and applies adds, changes, removals", async () => {
    const ui = await setup();
    try {
      ui.choose("Lea Schmitt", "Edit");
      ui.row("Lagerbot").querySelector<HTMLButtonElement>('button[aria-label="Remove Lagerbot"]')!.click();
      await waitFor(() => ui.row("Lagerbot").textContent?.includes("Will be removed") === true, "the removal mark");
      ui.dom.root.querySelector<HTMLInputElement>('input[aria-label="All signed-in people"]')!.click();
      await waitFor(() => ui.dom.root.textContent?.includes("3 changes") === true, "three changes");
      expect(ui.calls).toEqual([]);
      const text = ui.dom.root.textContent ?? "";
      expect(text).toContain("before View");
      expect(text).toContain("Lea Schmitt: View → Edit");
      expect(text).toContain("Lagerbot loses access");
      ui.button("Save").click();
      await waitFor(() => ui.close.mock.calls.length === 1, "the dialog to close");
      expect(ui.confirm).toHaveBeenCalledTimes(1);
      expect(String(ui.confirm.mock.calls[0]![0])).toContain("Lagerbot will lose access to Einkauf 2027.");
      expect(ui.calls).toEqual(["grant authenticated read", "update 2 write", "revoke 3"]);
      expect(ui.close.mock.calls[0]).toEqual([true]);
    } finally {
      ui.cleanup();
    }
  });

  test("Undo brings a removed row back, and a declined confirmation saves nothing", async () => {
    const ui = await setup();
    try {
      ui.row("Lea Schmitt").querySelector<HTMLButtonElement>('button[aria-label="Remove Lea Schmitt"]')!.click();
      await waitFor(() => !!ui.button("Undo"), "undo");
      ui.button("Undo").click();
      await waitFor(() => ui.dom.root.textContent?.includes("No changes") === true, "no changes");
      ui.row("Lea Schmitt").querySelector<HTMLButtonElement>('button[aria-label="Remove Lea Schmitt"]')!.click();
      ui.confirm.mockResolvedValueOnce(false);
      ui.button("Save").click();
      await Bun.sleep(30);
      expect(ui.calls).toEqual([]);
      expect(ui.close).not.toHaveBeenCalled();
      expect(ui.dom.root.textContent).toContain("Will be removed");
    } finally {
      ui.cleanup();
    }
  });

  test("the only manager keeps Manage: no removal, no lower level", async () => {
    const ui = await setup();
    try {
      const remove = ui.row("Mia Hoffmann").querySelector<HTMLButtonElement>("button[aria-label^='Give someone else']")!;
      expect(remove.disabled).toBe(true);
      const view = Array.from(ui.row("Mia Hoffmann").querySelectorAll<HTMLElement>('[role="option"]')).find((option) =>
        option.textContent?.includes("View"),
      )!;
      expect(view.getAttribute("aria-disabled") === "true" || view.hasAttribute("disabled")).toBe(true);
      // Once Lea manages too, Mia may step down.
      ui.choose("Lea Schmitt", "Manage");
      await waitFor(
        () => !ui.row("Mia Hoffmann").querySelector<HTMLButtonElement>('button[aria-label="Remove Mia Hoffmann"]')?.disabled,
        "Mia's removal",
      );
    } finally {
      ui.cleanup();
    }
  });

  test("a failed save keeps exactly the open changes and can be retried", async () => {
    let fail = true;
    const ui = await setup({
      updateAccess: async () => {
        if (fail) throw new Error("offline");
      },
    });
    try {
      ui.dom.root.querySelector<HTMLInputElement>('input[aria-label="All signed-in people"]')!.click();
      ui.choose("Lea Schmitt", "Edit");
      await waitFor(() => ui.dom.root.textContent?.includes("2 changes") === true, "two changes");
      ui.button("Save").click();
      await waitFor(() => !!ui.dom.root.querySelector('[role="alert"]'), "the failure");
      expect(ui.dom.root.querySelector('[role="alert"]')!.textContent).toContain("1 change is still open");
      expect(ui.dom.root.textContent).toContain("1 change");
      expect(ui.close).not.toHaveBeenCalled();
      fail = false;
      ui.button("Try again").click();
      await waitFor(() => ui.close.mock.calls.length === 1, "the dialog to close");
      expect(ui.calls).toEqual(["grant authenticated read"]);
    } finally {
      ui.cleanup();
    }
  });

  test("closing with changes asks before discarding them", async () => {
    const ui = await setup();
    try {
      ui.choose("Lea Schmitt", "Edit");
      ui.confirm.mockResolvedValueOnce(false);
      ui.button("Cancel").click();
      await Bun.sleep(30);
      expect(ui.close).not.toHaveBeenCalled();
      ui.button("Cancel").click();
      await waitFor(() => ui.close.mock.calls.length === 1, "the dialog to close");
      expect(ui.close.mock.calls[0]).toEqual([false]);
      expect(ui.calls).toEqual([]);
    } finally {
      ui.cleanup();
    }
  });
});
