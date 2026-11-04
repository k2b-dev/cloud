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

  const setup = async (
    overrides: {
      updateAccess?: () => Promise<void>;
      entries?: AccessEntry[];
      allowedLevels?: import("./PermissionEditor").AllowedLevel[];
      findServiceAccount?: (handle: string, signal: AbortSignal) => Promise<import("./AccessDialog").FoundServiceAccount | null>;
    } = {},
  ) => {
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
          initialEntries={overrides.entries ?? [mia, lea, bot]}
          allowedLevels={overrides.allowedLevels}
          findServiceAccount={overrides.findServiceAccount}
          viewerUserId={mia.principal.type === "user" ? mia.principal.userId : undefined}
          grantAccess={async (principal, permission, _display, scope) => {
            calls.push(`grant ${principal.type} ${permission}${scope ? ` ${scope}` : ""}`);
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

  test("a new grant keeps the scope of the level it starts with", async () => {
    const ui = await setup({ allowedLevels: [{ level: "read", scope: "assigned", label: "Assigned" }, "admin"] });
    try {
      ui.dom.root.querySelector<HTMLInputElement>('input[aria-label="All signed-in people"]')!.click();
      await waitFor(() => ui.dom.root.textContent?.includes("1 change") === true, "one change");
      ui.button("Save").click();
      await waitFor(() => ui.close.mock.calls.length === 1, "the dialog to close");
      expect(ui.calls).toEqual(["grant authenticated read assigned"]);
    } finally {
      ui.cleanup();
    }
  });

  test("two quick clicks on Save save once", async () => {
    const ui = await setup();
    try {
      ui.dom.root.querySelector<HTMLInputElement>('input[aria-label="All signed-in people"]')!.click();
      await waitFor(() => ui.dom.root.textContent?.includes("1 change") === true, "one change");
      ui.button("Save").click();
      ui.button("Save").click();
      await waitFor(() => ui.close.mock.calls.length >= 1, "the dialog to close");
      await Bun.sleep(30);
      expect(ui.calls).toEqual(["grant authenticated read"]);
      expect(ui.close).toHaveBeenCalledTimes(1);
    } finally {
      ui.cleanup();
    }
  });

  test("turning off signed-in access asks like any removal", async () => {
    const signedIn: AccessEntry = {
      id: "00000000-0000-4000-8000-000000000008",
      principal: { type: "authenticated" },
      permission: "read",
      createdAt: "2026-11-03T00:00:00.000Z",
    };
    const ui = await setup({ entries: [mia, signedIn] });
    try {
      ui.dom.root.querySelector<HTMLInputElement>('input[aria-label="All signed-in people"]')!.click();
      await waitFor(() => ui.dom.root.textContent?.includes("1 change") === true, "one change");
      ui.button("Save").click();
      await waitFor(() => ui.close.mock.calls.length === 1, "the dialog to close");
      expect(ui.confirm).toHaveBeenCalledTimes(1);
      expect(String(ui.confirm.mock.calls[0]![0])).toContain("All signed-in people will lose access to Einkauf 2027.");
    } finally {
      ui.cleanup();
    }
  });

  test("removing a row keeps it and moves focus to Undo; Undo returns focus to its remove button", async () => {
    const ui = await setup();
    try {
      const remove = ui.row("Lea Schmitt").querySelector<HTMLButtonElement>('button[aria-label="Remove Lea Schmitt"]')!;
      remove.focus();
      remove.click();
      await waitFor(() => ui.dom.document.activeElement?.textContent?.trim() === "Undo", "focus on Undo");
      ui.button("Undo").click();
      await waitFor(
        () => ui.dom.document.activeElement?.getAttribute("aria-label") === "Remove Lea Schmitt",
        "focus back on the remove button",
      );
    } finally {
      ui.cleanup();
    }
  });

  test("a changed identifier drops the answer for the old one", async () => {
    const pending = Promise.withResolvers<import("./AccessDialog").FoundServiceAccount | null>();
    const ui = await setup({ findServiceAccount: () => pending.promise });
    try {
      ui.button("Add service account").click();
      await waitFor(() => !!ui.dom.root.querySelector('input[aria-label="Identifier of the service account"]'), "the identifier field");
      const input = ui.dom.root.querySelector<HTMLInputElement>('input[aria-label="Identifier of the service account"]')!;
      input.value = "code-aaaaaaaaaa";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      ui.button("Find").click();
      input.value = "code-bbbbbbbbbb";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      pending.resolve({
        principal: { type: "service_account", serviceAccountId: "40000000-0000-4000-8000-000000000001" },
        display: { displayName: "Code of the old mailbox", serviceAccountKind: "resource_bound" },
      });
      await Bun.sleep(30);
      expect(ui.dom.root.textContent).not.toContain("Code of the old mailbox");
    } finally {
      ui.cleanup();
    }
  });

  test("an empty list claims nobody's access, also when the viewer is not listed", async () => {
    const ui = await setup({ entries: [] });
    try {
      expect(ui.dom.root.textContent).toContain("Nobody is listed yet.");
      expect(ui.dom.root.textContent).not.toContain("Only you");
    } finally {
      ui.cleanup();
    }
  });

  test("the owner's signal closes the dialog and stops a running save", async () => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    delegateEvents(["click", "input"], dom.document);
    const { openAccessDialog } = await import("./AccessDialog");
    const { prompts } = await import("@k2b/ui");
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    const owner = new AbortController();
    const calls: string[] = [];
    const held = Promise.withResolvers<void>();
    const opened = openAccessDialog({
      resourceName: "Einkauf 2027",
      initialEntries: [mia, lea, bot],
      signal: owner.signal,
      grantAccess: async (principal, permission) => {
        calls.push(`grant ${principal.type}`);
        return { id: "00000000-0000-4000-8000-000000000009", principal, permission, createdAt: "now" };
      },
      updateAccess: async (id) => {
        calls.push(`update ${id.slice(-1)}`);
        await held.promise;
      },
      revokeAccess: async (id) => {
        calls.push(`revoke ${id.slice(-1)}`);
      },
    });
    const dialog = () => dom.document.querySelector<HTMLElement>('[role="dialog"]');
    const row = (name: string) => Array.from(dialog()!.querySelectorAll("li")).find((item) => item.textContent?.includes(name))!;
    try {
      await waitFor(() => dialog()?.textContent?.includes("Lea Schmitt") === true, "the dialog");
      Array.from(row("Lea Schmitt").querySelectorAll<HTMLElement>('[role="option"]'))
        .find((option) => option.textContent?.includes("Edit"))!
        .click();
      row("Lagerbot").querySelector<HTMLButtonElement>('button[aria-label="Remove Lagerbot"]')!.click();
      await waitFor(() => dialog()?.textContent?.includes("2 changes") === true, "two changes");
      Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button"))
        .find((item) => item.textContent?.trim() === "Save")!
        .click();
      await waitFor(() => calls.length === 1, "the first saved change");
      owner.abort();
      expect(await opened).toBe(false);
      expect(dialog()).toBeNull();
      held.resolve();
      await Bun.sleep(20);
      // The level change was already sent; the removal after it never is.
      expect(calls).toEqual(["update 2"]);
    } finally {
      held.resolve();
      confirm.mockRestore();
      dom.cleanup();
    }
  });
});
