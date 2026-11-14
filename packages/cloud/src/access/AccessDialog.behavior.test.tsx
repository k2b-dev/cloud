import { describe, expect, mock, spyOn, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { AccessEntry } from "../contracts/shared";

/** Opens a row's level menu and picks a level, as a person would. */
const chooseLevel = (row: Element, level: string) => {
  row.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click();
  Array.from(row.querySelectorAll<HTMLElement>('[role="radio"]'))
    .find((option) => option.textContent?.includes(level))!
    .click();
};

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
const codeKind = "code";
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

/** happy-dom has no Popover API; the search's result list opens through it. */
const installPopoverApi = (window: Window) => {
  const prototype = (window as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement.prototype as unknown as Record<string, unknown>;
  const open = new WeakSet<object>();
  const matches = prototype.matches as (this: Element, selector: string) => boolean;
  Object.assign(prototype, {
    matches(this: Element, selector: string) {
      return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
    },
    showPopover(this: object) {
      open.add(this);
    },
    hidePopover(this: object) {
      open.delete(this);
    },
    scrollIntoView() {},
  });
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
      canEdit?: boolean;
    } = {},
  ) => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    delegateEvents(["click", "input"], dom.document);
    // Every Cloud page names the signed-in person in its shell data; the dialog marks them "You" from there.
    const shell = dom.document.createElement("script");
    shell.id = "cloud-shell-data";
    shell.type = "application/json";
    shell.textContent = JSON.stringify({ profile: { userId: mia.principal.type === "user" ? mia.principal.userId : undefined } });
    dom.document.body.append(shell);
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
          canEdit={overrides.canEdit}
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
    /** By accessible name or visible label. */
    const button = (text: string) =>
      Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find(
        (item) => item.getAttribute("aria-label") === text || item.textContent?.trim() === text,
      )!;
    /** Types a handle into the field "Add service account" opens; a complete one is looked up right away. */
    const typeHandle = (value: string) => {
      const input = dom.root.querySelector<HTMLInputElement>('input[aria-label="Handle of the service account"]')!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    /** The hit under the field, which adds the account when chosen. */
    const hit = (name: string) =>
      Array.from(dom.root.querySelectorAll<HTMLButtonElement>("li button")).find((item) => item.textContent?.includes(name));
    const choose = (name: string, level: string) => chooseLevel(row(name), level);
    return {
      dom,
      calls,
      close,
      confirm,
      row,
      button,
      typeHandle,
      hit,
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
      ui.row("Mia Hoffmann").querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click();
      const view = Array.from(ui.row("Mia Hoffmann").querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((option) =>
        option.textContent?.includes("View"),
      )!;
      expect(view.disabled).toBe(true);
      // The menu says why, and its Remove is off too.
      expect(ui.row("Mia Hoffmann").textContent).toContain("First give someone else “Manage”.");
      ui.row("Mia Hoffmann").querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click();
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
      const save = ui.button("Save");
      save.click();
      save.click();
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

  test("a Code account starts below Manage even when the resource lists Manage first", async () => {
    const ui = await setup({
      allowedLevels: ["admin", "write", "read"],
      findServiceAccount: async () => ({
        principal: { type: "service_account", serviceAccountId: "40000000-0000-4000-8000-000000000001" },
        display: { displayName: "Code of Werkstatt", serviceAccountKind: "code" },
      }),
    });
    try {
      ui.button("Add service account").click();
      ui.typeHandle("code-7k2q9m4xwt");
      await waitFor(() => !!ui.hit("Code of Werkstatt"), "the found account");
      ui.hit("Code of Werkstatt")!.click();
      expect(ui.row("Code of Werkstatt").textContent).toContain("Service account");
      ui.row("Code of Werkstatt").querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click();
      expect(
        Array.from(ui.row("Code of Werkstatt").querySelectorAll('[role="radio"]')).some((node) => node.textContent?.includes("Manage")),
      ).toBe(false);
      ui.row("Code of Werkstatt").querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click();
      ui.button("Save").click();
      await waitFor(() => ui.close.mock.calls.length === 1, "the saved account");
      expect(ui.calls).toEqual(["grant service_account write"]);
    } finally {
      ui.cleanup();
    }
  });

  test("a changed handle drops the answer for the old one", async () => {
    const pending = Promise.withResolvers<import("./AccessDialog").FoundServiceAccount | null>();
    const answers = [pending.promise, new Promise<null>(() => {})];
    const ui = await setup({ findServiceAccount: () => answers.shift()! });
    try {
      ui.button("Add service account").click();
      await waitFor(() => !!ui.dom.root.querySelector('input[aria-label="Handle of the service account"]'), "the handle field");
      ui.typeHandle("code-aaaaaaaaaa");
      ui.typeHandle("code-bbbbbbbbbb");
      pending.resolve({
        principal: { type: "service_account", serviceAccountId: "40000000-0000-4000-8000-000000000001" },
        display: { displayName: "Code of the old mailbox", serviceAccountKind: codeKind },
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
      chooseLevel(row("Lea Schmitt"), "Edit");
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

  test("a stored public denial shows as off, and switching it on grants the first level with the resource's own warning", async () => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    delegateEvents(["click", "input"], dom.document);
    const { AccessDialog } = await import("./AccessDialog");
    const calls: string[] = [];
    const denied: AccessEntry = {
      id: "00000000-0000-4000-8000-000000000004",
      principal: { type: "public" },
      permission: "none",
      createdAt: "2026-11-03T00:00:00.000Z",
    };
    const dispose = render(
      () => (
        <AccessDialog
          resourceName="Board"
          initialEntries={[mia, denied]}
          allowPublic
          publicWarning="Visitors can open the app and send its published forms without signing in."
          allowedLevels={[{ level: "read", label: "Open" }]}
          grantAccess={async (principal, permission) => ({ id: "x", principal, permission, createdAt: "now" })}
          updateAccess={async (id, permission) => {
            calls.push(`update ${id.slice(-1)} ${permission}`);
          }}
          revokeAccess={async (id) => {
            calls.push(`revoke ${id.slice(-1)}`);
          }}
          close={() => {}}
        />
      ),
      dom.root,
    );
    const publicSwitch = () => dom.root.querySelector<HTMLInputElement>('input[aria-label="Public with link"]')!;
    try {
      expect(publicSwitch().checked).toBe(false);
      expect(dom.root.textContent).not.toContain("Visitors can open the app");
      publicSwitch().click();
      await waitFor(() => dom.root.textContent?.includes("1 change") === true, "one change");
      expect(publicSwitch().checked).toBe(true);
      expect(dom.root.textContent).toContain("Visitors can open the app and send its published forms without signing in.");
      expect(dom.root.textContent).not.toContain("Nobody can change anything without signing in.");
      // Off again restores the stored denial: nothing to save.
      publicSwitch().click();
      await waitFor(() => !dom.root.textContent?.includes("1 change"), "no change");
      expect(calls).toEqual([]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  describe("denials", () => {
    // Like Grids: a principal's denial hides that principal's grants.
    const unshadowed = (entries: readonly AccessEntry[]) => {
      const denied = new Set(entries.filter((stored) => stored.permission === "none").map((stored) => JSON.stringify(stored.principal)));
      return entries.filter((stored) => !denied.has(JSON.stringify(stored.principal)));
    };
    const bob = user("5", "Bob Albers", "admin");
    const bobDenied: AccessEntry = { ...bob, id: "00000000-0000-4000-8000-000000000006", permission: "none" };
    const renderDialog = async (entries: AccessEntry[]) => {
      const dom = createDomTestHarness();
      dom.document.documentElement.lang = "en";
      delegateEvents(["click", "input"], dom.document);
      const { AccessDialog } = await import("./AccessDialog");
      const { prompts } = await import("@k2b/ui");
      const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
      const calls: string[] = [];
      const close = mock((_saved: boolean) => {});
      const dispose = render(
        () => (
          <AccessDialog
            resourceName="Projects"
            initialEntries={entries}
            effectiveEntries={unshadowed}
            grantAccess={async (principal, permission) => ({ id: "x", principal, permission, createdAt: "now" })}
            updateAccess={async (id, permission) => {
              calls.push(`update ${id.slice(-1)} ${permission}`);
            }}
            revokeAccess={async (id) => {
              calls.push(`revoke ${id.slice(-1)}`);
            }}
            close={close}
          />
        ),
        dom.root,
      );
      const rows = (name: string) => Array.from(dom.root.querySelectorAll("li")).filter((item) => item.textContent?.includes(name));
      const button = (text: string) =>
        Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === text)!;
      return {
        dom,
        calls,
        close,
        confirm,
        rows,
        button,
        cleanup: () => {
          dispose();
          confirm.mockRestore();
          dom.cleanup();
        },
      };
    };

    test("a signed-in grant next to a signed-in denial: the switch shows the denial, the grant stays visible", async () => {
      const grantAll: AccessEntry = {
        id: "00000000-0000-4000-8000-000000000007",
        principal: { type: "authenticated" },
        permission: "read",
        createdAt: "now",
      };
      const denyAll: AccessEntry = { ...grantAll, id: "00000000-0000-4000-8000-000000000008", permission: "none" };
      const ui = await renderDialog([mia, grantAll, denyAll]);
      try {
        expect(ui.dom.root.querySelector<HTMLInputElement>('input[aria-label="All signed-in people"]')!.checked).toBe(false);
        expect(ui.rows("All signed-in people").some((item) => item.querySelector("[data-access-remove]"))).toBe(true);
      } finally {
        ui.cleanup();
      }
    });

    test("removing a denial is described as such and asks nothing", async () => {
      const ui = await renderDialog([mia, bob, bobDenied]);
      try {
        const denialRow = ui.rows("Bob Albers").find((item) => item.textContent?.includes("No access"))!;
        denialRow.querySelector<HTMLButtonElement>("[data-access-remove]")!.click();
        await waitFor(() => ui.dom.root.textContent?.includes("the denial is removed") === true, "the summary");
        ui.button("Save").click();
        await waitFor(() => ui.close.mock.calls.length === 1, "the dialog to close");
        expect(ui.confirm).not.toHaveBeenCalled();
        expect(ui.calls).toEqual(["revoke 6"]);
      } finally {
        ui.cleanup();
      }
    });

    test("Undo cannot bring back a denial that would leave nobody managing", async () => {
      const ui = await renderDialog([mia, bob, bobDenied]);
      try {
        const denialRow = () =>
          ui.rows("Bob Albers").find((item) => item.querySelector("[data-access-undo]") || item.textContent?.includes("No access"))!;
        denialRow().querySelector<HTMLButtonElement>("[data-access-remove]")!.click();
        await waitFor(() => !!denialRow().querySelector("[data-access-undo]"), "the removal mark");
        const miaRow = ui.rows("Mia Hoffmann")[0]!;
        chooseLevel(miaRow, "View");
        await waitFor(() => ui.dom.root.textContent?.includes("2 changes") === true, "two changes");
        expect(denialRow().querySelector<HTMLButtonElement>("[data-access-undo]")!.disabled).toBe(true);
      } finally {
        ui.cleanup();
      }
    });
  });

  describe("service accounts as in the approved mockup", () => {
    const codeAccount: AccessEntry = {
      id: "00000000-0000-4000-8000-000000000010",
      principal: { type: "service_account", serviceAccountId: "20000000-0000-4000-8000-000000000010" },
      permission: "write",
      createdAt: "2026-11-03T00:00:00.000Z",
      displayName: "Code von einkauf@beispiel.de",
      serviceAccountKind: codeKind,
    };
    const field = (ui: Awaited<ReturnType<typeof setup>>) =>
      ui.dom.root.querySelector<HTMLInputElement>('input[aria-label="Handle of the service account"]');
    const openAdding = async (ui: Awaited<ReturnType<typeof setup>>) => {
      ui.button("Add service account").click();
      await waitFor(() => !!field(ui), "the handle field");
    };
    const cancelAdding = async (ui: Awaited<ReturnType<typeof setup>>) => {
      Array.from(field(ui)!.closest("form")!.querySelectorAll<HTMLButtonElement>("button"))
        .find((item) => item.textContent?.trim() === "Cancel")!
        .click();
      await waitFor(() => !field(ui), "the handle field to close");
    };
    const empty = "No service account yet. Code of a mailbox or a base gets access here like a person.";
    const note =
      "Code runs as the service account of its object. Whoever manages “Einkauf 2027” gives it access here, like a person. Whoever edits the code acts with this right.";

    test("without rows: the empty text, the handle hint, and nothing while adding", async () => {
      const ui = await setup({ entries: [mia], findServiceAccount: async () => null });
      try {
        const text = () => ui.dom.root.textContent ?? "";
        expect(text()).toContain(empty);
        expect(text()).not.toContain("Code runs as the service account");
        await openAdding(ui);
        expect(field(ui)!.placeholder).toBe("Handle from the code page, for example code-7k2q9m4xwt");
        expect(text()).not.toContain(empty);
        await cancelAdding(ui);
        expect(text()).toContain(empty);
      } finally {
        ui.cleanup();
      }
    });

    test("with rows: one note under them naming the resource, gone while adding, and the code icon in a square", async () => {
      const ui = await setup({ entries: [mia, codeAccount], findServiceAccount: async () => null });
      try {
        const text = () => ui.dom.root.textContent ?? "";
        expect(text()).toContain(note);
        expect(text()).not.toContain(empty);
        await openAdding(ui);
        expect(text()).not.toContain(note);
        await cancelAdding(ui);
        expect(text()).toContain(note);
        const avatar = ui.row("Code von einkauf@beispiel.de").querySelector('[data-shape="square"]');
        expect(avatar?.querySelector(".ti-code")).not.toBeNull();
      } finally {
        ui.cleanup();
      }
    });

    test("a Code account keeps its kind and is never offered Manage, also when added by its handle", async () => {
      const found: import("./AccessDialog").FoundServiceAccount = {
        principal: { type: "service_account" as const, serviceAccountId: "20000000-0000-4000-8000-000000000012" },
        display: { displayName: "Code von lager@beispiel.de", serviceAccountKind: codeKind },
      };
      const ui = await setup({
        entries: [mia, codeAccount],
        allowedLevels: ["admin", "write", "read"],
        findServiceAccount: async () => found,
      });
      try {
        const offered = (name: string) => {
          ui.row(name).querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click();
          const labels = Array.from(ui.row(name).querySelectorAll('[role="radio"]')).map((radio) => radio.textContent ?? "");
          ui.row(name).querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click();
          return labels;
        };
        expect(offered("Code von einkauf@beispiel.de").some((label) => label.includes("Manage"))).toBe(false);
        expect(offered("Mia Hoffmann").some((label) => label.includes("Manage"))).toBe(true);
        await openAdding(ui);
        field(ui)!.value = "code-7k2q9m4xwt";
        field(ui)!.dispatchEvent(new Event("input", { bubbles: true }));
        await waitFor(() => !!ui.hit("Code von lager@beispiel.de"), "the found account");
        ui.hit("Code von lager@beispiel.de")!.click();
        // An app whose first level is Manage still starts the Code account below it.
        await waitFor(() => !!ui.row("Code von lager@beispiel.de"), "the added row");
        const added = ui.row("Code von lager@beispiel.de");
        expect(added.querySelector('button[aria-haspopup="dialog"]')?.textContent).not.toContain("Manage");
        expect(offered("Code von lager@beispiel.de").some((label) => label.includes("Manage"))).toBe(false);
      } finally {
        ui.cleanup();
      }
    });

    test("the account behind an object's API keys is an API key, never a service account", async () => {
      const apiKey: AccessEntry = {
        id: "00000000-0000-4000-8000-000000000011",
        principal: { type: "service_account", serviceAccountId: "20000000-0000-4000-8000-000000000011" },
        permission: "read",
        createdAt: "2026-11-03T00:00:00.000Z",
        displayName: "Shop-Import",
        serviceAccountKind: "resource_bound",
      };
      const ui = await setup({ entries: [mia, codeAccount, apiKey], findServiceAccount: async () => null });
      try {
        const section = (title: string) =>
          Array.from(ui.dom.root.querySelectorAll("section")).find((item) => item.querySelector("h3")?.textContent?.startsWith(title));
        expect(section("Service accounts")?.textContent).toContain("Code von einkauf@beispiel.de");
        expect(section("Service accounts")?.textContent).not.toContain("Shop-Import");
        expect(section("API keys")?.textContent).toContain("Shop-Import");
        const row = ui.row("Shop-Import");
        expect(row.textContent).toContain("API key");
        expect(row.textContent).not.toContain("Service account");
        expect(row.querySelector('[data-shape="square"] .ti-key')).not.toBeNull();
      } finally {
        ui.cleanup();
      }
    });

    test("in German the note quotes the resource's name, so any name reads", async () => {
      const { accessDialogMessages } = await import("./access-dialog-messages");
      expect(accessDialogMessages.resolve(["de"]).t.serviceAccountNote({ name: "Der Einkauf" })).toBe(
        "Code läuft als Dienstkonto seines Objekts. Wer „Der Einkauf“ verwaltet, gibt ihm hier Zugriff wie einer Person. Wer den Code bearbeitet, handelt mit diesem Recht.",
      );
      expect(accessDialogMessages.resolve(["de"]).t.serviceAccountsEmpty).toBe(
        "Noch kein Dienstkonto. Code eines Postfachs oder einer Base bekommt hier Zugriff wie eine Person.",
      );
      expect(accessDialogMessages.resolve(["de"]).t.serviceAccountHandlePlaceholder).toBe(
        "Kennung von der Code-Seite, etwa code-7k2q9m4xwt",
      );
    });

    describe("a handle in the search for people", () => {
      const handle = "code-7k2q9m4xwt";
      const found: import("./AccessDialog").FoundServiceAccount = {
        principal: { type: "service_account", serviceAccountId: "20000000-0000-4000-8000-000000000012" },
        display: { displayName: "Code von info@beispiel.de", serviceAccountKind: "code" },
        description: "Service account of a mailbox",
      };
      /** Types into the search; directory requests are recorded so a test can prove the directory was not asked. */
      const search = async (findServiceAccount: (handle: string, signal: AbortSignal) => Promise<typeof found | null>, query: string) => {
        const originalFetch = globalThis.fetch;
        const directory: URL[] = [];
        globalThis.fetch = Object.assign(
          async (input: string | URL | Request) => {
            directory.push(new URL(input instanceof Request ? input.url : input.toString()));
            return Response.json({ items: [] });
          },
          { preconnect: originalFetch.preconnect },
        );
        const lookups: string[] = [];
        const ui = await setup({
          entries: [mia],
          findServiceAccount: (value, signal) => {
            lookups.push(value);
            return findServiceAccount(value, signal);
          },
        });
        installPopoverApi(ui.dom.window as unknown as Window);
        const input = ui.dom.root.querySelector<HTMLInputElement>("input[role=combobox]")!;
        input.value = query;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        // The search's own list, never the level menus of the rows.
        const list = () => ui.dom.document.getElementById(input.getAttribute("aria-controls") ?? "");
        const options = () => Array.from(list()?.querySelectorAll<HTMLButtonElement>('button[role="option"]') ?? []);
        const status = () => list()?.textContent ?? "";
        const section = (title: string) =>
          Array.from(ui.dom.root.querySelectorAll("section")).find((item) => item.querySelector("h2, h3")?.textContent?.startsWith(title));
        return {
          ...ui,
          directory,
          lookups,
          options,
          status,
          section,
          cleanup: () => {
            ui.cleanup();
            globalThis.fetch = originalFetch;
          },
        };
      };

      test("asks the same targeted lookup, marks the hit, and adds it under Service accounts", async () => {
        const ui = await search(async () => found, handle);
        try {
          await waitFor(() => ui.options().length === 1, "the service account in the results");
          const option = ui.options()[0]!;
          expect(ui.lookups).toEqual([handle]);
          expect(ui.directory).toEqual([]);
          expect(option.querySelector("strong")?.textContent).toBe("Code von info@beispiel.de");
          expect(option.querySelector("small")?.textContent).toBe("Service account of a mailbox · goes to Service accounts");
          expect(option.querySelector(".k2b-choice-option__badge")?.textContent).toBe("Service account");
          expect(option.querySelector(".ti-code")).not.toBeNull();
          option.click();
          await waitFor(() => ui.section("Service accounts")?.textContent?.includes("Code von info@beispiel.de") === true, "the new row");
          expect(ui.section("People")?.textContent).not.toContain("Code von info@beispiel.de");
          expect(ui.section("Service accounts")?.textContent).toContain("New");
          expect(ui.dom.root.textContent).toContain("Code von info@beispiel.de gets Edit");
          // The row keeps the server's line, not the search's "goes to Service accounts".
          expect(ui.row("Code von info@beispiel.de").textContent).toContain("Service account of a mailbox · may edit");
          ui.button("Save").click();
          await waitFor(() => ui.close.mock.calls.length === 1, "the saved account");
          expect(ui.calls).toEqual(["grant service_account write"]);
        } finally {
          ui.cleanup();
        }
      });

      test("a name never finds a service account: only the directory is asked, without Code accounts", async () => {
        const ui = await search(async () => found, "Code von info");
        try {
          await waitFor(() => ui.directory.length > 0, "the directory search");
          await Bun.sleep(30);
          expect(ui.lookups).toEqual([]);
          expect(ui.directory[0]!.searchParams.get("service_account_kinds")).toBe("agent,standalone");
          expect(ui.options().length).toBe(0);
          for (const prefix of ["code-7k2q", "code-7k2q9m4xwtx", "CODE-7k2q9m4xwt"]) {
            const input = ui.dom.root.querySelector<HTMLInputElement>("input[role=combobox]")!;
            input.value = prefix;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            await waitFor(
              () => ui.directory.some((url) => url.searchParams.get("search") === prefix),
              `the directory search for ${prefix}`,
            );
          }
          expect(ui.lookups).toEqual([]);
        } finally {
          ui.cleanup();
        }
      });

      test("someone who does not manage the target gets nothing, and a refused lookup says so", async () => {
        // The server answers a non-manager with no item; the lookup turns that into null.
        const ui = await search(async () => null, handle);
        try {
          await waitFor(() => ui.status().includes(`Nobody is called “${handle}”.`), "the empty result");
          expect(ui.lookups).toEqual([handle]);
          expect(ui.directory).toEqual([]);
          expect(ui.options().length).toBe(0);
          expect(ui.dom.root.textContent).not.toContain("Code von info@beispiel.de");
        } finally {
          ui.cleanup();
        }
        const limited = await search(async () => {
          throw new Error("Too many requests");
        }, handle);
        try {
          await waitFor(() => limited.status().includes("Too many requests"), "the refused lookup");
          expect(limited.options().length).toBe(0);
        } finally {
          limited.cleanup();
        }
      });
    });

    const mailboxCode: AccessEntry = {
      ...codeAccount,
      serviceAccountKind: "code",
      serviceAccountDescription: "Service account of a mailbox",
      serviceAccountHref: "/app/mail/Mb4kd2/code",
    };
    const appCode: AccessEntry = {
      id: "00000000-0000-4000-8000-000000000013",
      principal: { type: "service_account", serviceAccountId: "20000000-0000-4000-8000-000000000013" },
      permission: "read",
      createdAt: "2026-11-03T00:00:00.000Z",
      displayName: "Code of Werkstatt",
      serviceAccountKind: "code",
      serviceAccountDescription: "Service account of an app",
    };
    const heading = (ui: Awaited<ReturnType<typeof setup>>) =>
      Array.from(ui.dom.root.querySelectorAll("section"))
        .find((item) => item.querySelector("h3")?.textContent?.startsWith("Service accounts"))
        ?.querySelector("header");
    const found: import("./AccessDialog").FoundServiceAccount = {
      principal: { type: "service_account", serviceAccountId: "20000000-0000-4000-8000-000000000014" },
      display: { displayName: "Code von info@beispiel.de", serviceAccountKind: "code" },
      description: "Service account of a mailbox",
    };

    test("each row: code icon, the server's line with its level, a level menu and a remove button", async () => {
      const ui = await setup({ entries: [mia, mailboxCode, appCode], findServiceAccount: async () => null });
      try {
        expect(heading(ui)?.querySelector("h3")?.textContent).toBe("Service accounts 2");
        // Its visible label is its name, at every width.
        const add = Array.from(heading(ui)!.querySelectorAll("button")).find((item) => item.textContent?.trim() === "Add service account");
        expect(add?.hasAttribute("aria-label")).toBe(false);
        expect(add?.getAttribute("data-variant")).toBe("secondary");
        expect(add?.getAttribute("data-size")).toBe("sm");
        const mailbox = ui.row("Code von einkauf@beispiel.de");
        expect(mailbox.textContent).toContain("Service account of a mailbox · may edit");
        expect(ui.row("Code of Werkstatt").textContent).toContain("Service account of an app · may view");
        expect(mailbox.querySelector('[aria-label="Level for Code von einkauf@beispiel.de"]')).not.toBeNull();
        expect(mailbox.querySelector('button[aria-label="Remove Code von einkauf@beispiel.de"]')).not.toBeNull();
        // One hue for all code, whatever the name.
        const hues = ["Code von einkauf@beispiel.de", "Code of Werkstatt"].map((name) =>
          ui.row(name).querySelector<HTMLElement>('[data-shape="square"]')?.style.getPropertyValue("--k2b-avatar-hue"),
        );
        expect(hues).toEqual(["#0369a1", "#0369a1"]);
        // The level follows the menu.
        ui.choose("Code von einkauf@beispiel.de", "View");
        expect(mailbox.textContent).toContain("Service account of a mailbox · may view");
        const { accessDialogMessages } = await import("./access-dialog-messages");
        expect(accessDialogMessages.resolve(["de"]).t.levelFor({ name: "Code von Werkstatt" })).toBe("Stufe für Code von Werkstatt");
        expect(accessDialogMessages.resolve(["de"]).t.accountMay({ level: "Bearbeiten" })).toBe("darf bearbeiten");
      } finally {
        ui.cleanup();
      }
    });

    test("the name leads where the server says, and is text without a link", async () => {
      const ui = await setup({ entries: [mia, mailboxCode, appCode], findServiceAccount: async () => null });
      try {
        const link = ui.row("Code von einkauf@beispiel.de").querySelector("a");
        expect(link?.getAttribute("href")).toBe("/app/mail/Mb4kd2/code");
        expect(link?.textContent).toBe("Code von einkauf@beispiel.de");
        // A new tab keeps the unsaved draft.
        expect(link?.getAttribute("target")).toBe("_blank");
        expect(ui.row("Code of Werkstatt").querySelector("a")).toBeNull();
      } finally {
        ui.cleanup();
      }
      // Code of an app: the server gives Cloud-Admins Administration › Code.
      const admin = await setup({
        entries: [mia, { ...appCode, serviceAccountHref: "/admin/code?sec=code&app=werkstatt" }],
        findServiceAccount: async () => null,
      });
      try {
        expect(admin.row("Code of Werkstatt").querySelector("a")?.getAttribute("href")).toBe("/admin/code?sec=code&app=werkstatt");
      } finally {
        admin.cleanup();
      }
    });

    test("the count is 0 without rows, the button stands beside the title, and the empty text follows without a gap", async () => {
      const ui = await setup({ entries: [mia], findServiceAccount: async () => null });
      try {
        expect(heading(ui)?.querySelector("h3")?.textContent).toBe("Service accounts 0");
        expect(heading(ui)?.textContent).toContain("Add service account");
        const body = heading(ui)!.parentElement!.querySelector(".k2b-panel-dialog__section-body")!;
        // No empty list before the text, so nothing stands between title and text.
        expect(body.querySelector("ul")).toBeNull();
        expect(body.firstElementChild?.textContent).toBe(empty);
      } finally {
        ui.cleanup();
      }
    });

    test("while the field is open, Add service account is gone; the sheet scrolls to the field", async () => {
      const ui = await setup({ entries: [mia, mailboxCode], findServiceAccount: async () => found });
      const proto = (ui.dom.window as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement.prototype;
      const scrolled: Element[] = [];
      proto.scrollIntoView = function (this: Element) {
        scrolled.push(this);
      };
      try {
        await openAdding(ui);
        await Bun.sleep(0);
        expect(heading(ui)?.textContent).not.toContain("Add service account");
        expect(ui.dom.root.textContent).not.toContain(note);
        expect(scrolled).toContain(field(ui)!.closest("li")!);
        expect(field(ui)!.closest(".k2b-input-shell, .k2b-text-input")?.querySelector(".ti-code")).not.toBeNull();
        // No extra step: the field has only Cancel beside it.
        expect(Array.from(field(ui)!.closest("form")!.querySelectorAll("button")).map((item) => item.textContent?.trim())).toEqual([
          "Cancel",
        ]);
        ui.typeHandle("code-7k2q9m4xwt");
        await waitFor(() => !!ui.hit("Code von info@beispiel.de"), "the hit");
        const hit = ui.hit("Code von info@beispiel.de")!;
        expect(hit.textContent).toContain("Service account of a mailbox");
        expect(hit.querySelector(".k2b-status-badge")?.textContent).toContain("Service account");
        hit.click();
        expect(heading(ui)?.querySelector("h3")?.textContent).toBe("Service accounts 2");
        expect(heading(ui)?.textContent).toContain("Add service account");
      } finally {
        ui.cleanup();
      }
    });

    test("a failed lookup says so, and Enter asks again instead of claiming nothing was found", async () => {
      let attempts = 0;
      const ui = await setup({
        entries: [mia],
        findServiceAccount: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("offline");
          return found;
        },
      });
      try {
        await openAdding(ui);
        ui.typeHandle("code-7k2q9m4xwt");
        await waitFor(() => ui.dom.root.textContent?.includes("The service account could not be looked up.") === true, "the failure");
        field(ui)!
          .closest("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await waitFor(() => !!ui.hit("Code von info@beispiel.de"), "the hit after retrying");
        expect(attempts).toBe(2);
        expect(ui.dom.root.textContent).not.toContain("No service account with this handle");
      } finally {
        ui.cleanup();
      }
    });

    test("an app's own line under a row never replaces a service account's description and level", async () => {
      const { AccessDialog } = await import("./AccessDialog");
      const harness = createDomTestHarness();
      const dispose = render(
        () => (
          <AccessDialog
            resourceName="Einkauf 2027"
            initialEntries={[mia, mailboxCode]}
            entryDetail={() => "App detail"}
            grantAccess={async (principal, permission) => ({ id: crypto.randomUUID(), principal, permission, createdAt: "now" })}
            updateAccess={async () => {}}
            revokeAccess={async () => {}}
            close={() => {}}
          />
        ),
        harness.root,
      );
      try {
        const row = Array.from(harness.root.querySelectorAll("li")).find((item) => item.textContent?.includes("Code von einkauf"))!;
        expect(row.textContent).toContain("Service account of a mailbox · may edit");
        expect(row.textContent).not.toContain("App detail");
      } finally {
        dispose();
        harness.cleanup();
      }
    });

    test("a new Code account starts with Edit, counts in the title, and What changes says what that allows", async () => {
      const ui = await setup({ entries: [mia, mailboxCode], findServiceAccount: async () => found });
      try {
        await openAdding(ui);
        ui.typeHandle("code-7k2q9m4xwt");
        await waitFor(() => !!ui.hit("Code von info@beispiel.de"), "the hit");
        ui.hit("Code von info@beispiel.de")!.click();
        const row = ui.row("Code von info@beispiel.de");
        expect(row.textContent).toContain("New");
        expect(row.textContent).toContain("Service account of a mailbox · may edit");
        expect(heading(ui)?.querySelector("h3")?.textContent).toBe("Service accounts 2");
        const text = ui.dom.root.textContent ?? "";
        expect(text).toContain("Code von info@beispiel.de gets Edit");
        expect(text).toContain("The code may do everything Edit allows, not only what it calls today.");
        // Nothing applies before Save.
        expect(ui.calls).toEqual([]);
        const { accessDialogMessages } = await import("./access-dialog-messages");
        expect(accessDialogMessages.resolve(["de"]).t.codeMayAll({ level: "Bearbeiten" })).toBe(
          "Der Code darf alles, was Bearbeiten erlaubt, nicht nur das, was er heute aufruft.",
        );
        ui.button("Save").click();
        await waitFor(() => ui.close.mock.calls.length === 1, "the saved account");
        expect(ui.calls).toEqual(["grant service_account write"]);
      } finally {
        ui.cleanup();
      }
    });

    test("while saving, Add service account is locked", async () => {
      const pending = Promise.withResolvers<void>();
      const ui = await setup({
        entries: [mia, lea, mailboxCode],
        findServiceAccount: async () => null,
        updateAccess: () => pending.promise,
      });
      try {
        ui.choose("Lea Schmitt", "Edit");
        ui.button("Save").click();
        await waitFor(() => ui.button("Add service account")?.disabled === true, "the locked button");
        pending.resolve();
        await waitFor(() => ui.close.mock.calls.length === 1, "the save");
      } finally {
        ui.cleanup();
      }
    });

    test("removing a Code account asks the red Remove access? like a person, and Back keeps everything", async () => {
      const ui = await setup({ entries: [mia, mailboxCode], findServiceAccount: async () => null });
      ui.confirm.mockResolvedValue(false);
      try {
        ui.row("Code von einkauf@beispiel.de")
          .querySelector<HTMLButtonElement>('button[aria-label="Remove Code von einkauf@beispiel.de"]')!
          .click();
        ui.button("Save").click();
        await waitFor(() => ui.confirm.mock.calls.length === 1, "the confirmation");
        const [message, options] = ui.confirm.mock.calls[0]!;
        expect(message).toContain("Code von einkauf@beispiel.de will lose access to Einkauf 2027.");
        expect(options).toMatchObject({ title: "Remove access?", variant: "danger", confirmText: "Remove access", cancelText: "Back" });
        await Bun.sleep(10);
        expect(ui.calls).toEqual([]);
        expect(ui.close).not.toHaveBeenCalled();
        expect(ui.dom.root.textContent).toContain("Will be removed");
        const { accessDialogMessages } = await import("./access-dialog-messages");
        expect(accessDialogMessages.resolve(["de"]).t.confirmTitle).toBe("Zugriff entziehen?");
      } finally {
        ui.cleanup();
      }
    });

    test("read-only: the level stands under the name, without controls, and no empty section", async () => {
      const ui = await setup({ entries: [mia, mailboxCode, appCode], findServiceAccount: async () => found, canEdit: false });
      try {
        const row = ui.row("Code von einkauf@beispiel.de");
        expect(row.textContent).toContain("May edit");
        expect(row.textContent).not.toContain("Service account of a mailbox");
        expect(ui.row("Code of Werkstatt").textContent).toContain("May view");
        expect(row.querySelector("button, select, [role=combobox]")).toBeNull();
        // Nothing on the right: the level is already in the line under the name.
        expect(row.lastElementChild?.textContent).toContain("May edit");
        expect(heading(ui)?.textContent).not.toContain("Add service account");
      } finally {
        ui.cleanup();
      }
      const empty = await setup({ entries: [mia], findServiceAccount: async () => found, canEdit: false });
      try {
        expect(heading(empty)).toBeUndefined();
      } finally {
        empty.cleanup();
      }
    });

    test("a found account with a picture shows it in the preview", async () => {
      const ui = await setup({
        entries: [mia],
        findServiceAccount: async () => ({
          principal: { type: "service_account", serviceAccountId: "20000000-0000-4000-8000-000000000011" },
          display: { displayName: "Code von info@beispiel.de", avatarHash: "abc123", serviceAccountKind: codeKind },
        }),
      });
      try {
        await openAdding(ui);
        ui.typeHandle("code-7k2q9m4xwt");
        await waitFor(() => ui.dom.root.textContent?.includes("Code von info@beispiel.de") === true, "the found account");
        const preview = Array.from(ui.dom.root.querySelectorAll("div")).find(
          (item) => item.textContent?.includes("Code von info@beispiel.de") && item.querySelector("img"),
        );
        expect(preview?.querySelector("img")?.getAttribute("src")).toContain("rev=abc123");
      } finally {
        ui.cleanup();
      }
    });
  });

  describe("states as in the approved mockup", () => {
    const renderDialog = async (props: Partial<import("./AccessDialog").AccessDialogProps> = {}) => {
      const dom = createDomTestHarness();
      dom.document.documentElement.lang = "en";
      // happy-dom has no Popover API; the search results open through it.
      const prototype = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>;
      const open = new WeakSet<object>();
      const matches = prototype.matches as (this: Element, selector: string) => boolean;
      Object.assign(prototype, {
        matches(this: Element, selector: string) {
          return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
        },
        showPopover(this: object) {
          open.add(this);
        },
        hidePopover(this: object) {
          open.delete(this);
        },
        scrollIntoView() {},
      });
      delegateEvents(["click", "input", "keydown"], dom.document);
      const { AccessDialog } = await import("./AccessDialog");
      const close = mock((_saved: boolean) => {});
      const dispose = render(
        () => (
          <AccessDialog
            resourceName="Einkauf 2027"
            initialEntries={props.loadEntries ? undefined : [mia, lea]}
            grantAccess={async (principal, permission) => ({ id: "x", principal, permission, createdAt: "now" })}
            updateAccess={async () => {}}
            revokeAccess={async () => {}}
            close={close}
            {...props}
          />
        ),
        dom.root,
      );
      const text = () => dom.root.textContent ?? "";
      const button = (label: string) =>
        Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === label);
      const row = (name: string) => Array.from(dom.root.querySelectorAll("li")).find((item) => item.textContent?.includes(name))!;
      return { dom, text, button, row, close, cleanup: () => (dispose(), dom.cleanup()) };
    };
    const search = async (dom: ReturnType<typeof createDomTestHarness>, query: string) => {
      const input = dom.root.querySelector<HTMLInputElement>("input[role=combobox]")!;
      input.focus();
      input.value = query;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const withDirectory = (items: unknown[], urls: string[] = []) => {
      const original = globalThis.fetch;
      globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL) => {
          urls.push(String(input));
          return Response.json({ items });
        },
        { preconnect: original.preconnect },
      );
      return () => {
        globalThis.fetch = original;
      };
    };

    test("an empty search names the search and says what to search for", async () => {
      const restore = withDirectory([]);
      const ui = await renderDialog();
      try {
        await search(ui.dom, "xyz");
        await waitFor(() => ui.text().includes("Nobody is called “xyz”."), "the empty text");
        expect(ui.text()).toContain("Search by name, email or group.");
      } finally {
        ui.cleanup();
        restore();
      }
    });

    test("someone already on the list stays in the results, greyed with their level", async () => {
      const urls: string[] = [];
      const restore = withDirectory(
        [
          { kind: "user", user: { id: "10000000-0000-4000-8000-000000000002", uid: "lea", displayName: "Lea Schmitt", mail: null } },
          {
            kind: "user",
            user: { id: "10000000-0000-4000-8000-000000000008", uid: "tom", displayName: "Tom Berg", mail: "tom@beispiel.de" },
          },
        ],
        urls,
      );
      const ui = await renderDialog();
      try {
        await search(ui.dom, "le");
        const option = () =>
          Array.from(ui.dom.root.querySelectorAll<HTMLElement>('[role="option"]')).find((item) =>
            item.textContent?.includes("Lea Schmitt"),
          );
        await waitFor(() => !!option(), "Lea in the results");
        expect(option()!.getAttribute("aria-disabled")).toBe("true");
        expect(option()!.textContent).toContain("already has View");
        // The directory has to return listed people too, or they could never show greyed.
        expect(urls.some((url) => url.includes("exclude_"))).toBe(false);
        option()!.click();
        await Bun.sleep(20);
        expect(ui.text()).not.toContain("1 change");
      } finally {
        ui.cleanup();
        restore();
      }
    });

    test("read-only names who manages, shows General in words, and offers only Close", async () => {
      const ui = await renderDialog({ canEdit: false });
      try {
        expect(ui.text()).toContain("Only those who manage it can change access: Mia Hoffmann.");
        expect(ui.row("All signed-in people").textContent).toContain("Off");
        expect(ui.dom.root.querySelector('input[aria-label="All signed-in people"]')).toBeNull();
        expect(ui.button("Close")).toBeDefined();
        expect(ui.button("Save")).toBeUndefined();
        expect(ui.button("Cancel")).toBeUndefined();
        expect(ui.text()).not.toContain("No changes");
      } finally {
        ui.cleanup();
      }
    });

    test("read-only names only those who really manage: no denied or scoped managers", async () => {
      const ben = user("5", "Ben Albers", "admin");
      const benDenied: AccessEntry = { ...ben, id: "00000000-0000-4000-8000-000000000006", permission: "none" };
      const ida: AccessEntry = { ...user("7", "Ida Kranz", "admin"), scope: "assigned" };
      const denied = (entries: readonly AccessEntry[]) => {
        const keys = new Set(entries.filter((stored) => stored.permission === "none").map((stored) => JSON.stringify(stored.principal)));
        return entries.filter((stored) => !keys.has(JSON.stringify(stored.principal)));
      };
      const ui = await renderDialog({ canEdit: false, initialEntries: [mia, ben, benDenied, ida, lea], effectiveEntries: denied });
      try {
        expect(ui.text()).toContain("Only those who manage it can change access: Mia Hoffmann.");
      } finally {
        ui.cleanup();
      }
    });

    test("loading shows rows that are still coming, without the search; a failure offers Try again", async () => {
      let attempt = 0;
      const held = Promise.withResolvers<void>();
      const ui = await renderDialog({
        loadEntries: async () => {
          attempt += 1;
          if (attempt === 1) throw new Error("offline");
          await held.promise;
          return [mia, lea];
        },
      });
      try {
        await waitFor(() => ui.text().includes("Access could not be loaded."), "the load failure");
        ui.button("Try again")!.click();
        await waitFor(() => !!ui.dom.root.querySelector('[aria-busy="true"]'), "the loading rows");
        expect(ui.dom.root.querySelector("input[role=combobox]")).toBeNull();
        expect(ui.text()).toContain("Loading access");
        // General keeps its place, as in the approved mockup, but its state is not known yet: no "Off", no switch to use.
        expect(ui.text()).toContain("All signed-in people");
        expect(ui.text()).not.toContain("Off. Only those listed above have access.");
        expect(ui.dom.root.querySelector<HTMLInputElement>('input[aria-label="All signed-in people"]')!.disabled).toBe(true);
        held.resolve();
        await waitFor(() => ui.text().includes("Lea Schmitt"), "the loaded rows");
        expect(ui.dom.root.querySelector("input[role=combobox]")).not.toBeNull();
        expect(ui.text()).toContain("All signed-in people");
        // Nothing was saved: closing after the load does not tell the caller to reload.
        ui.button("Cancel")!.click();
        await waitFor(() => ui.close.mock.calls.length > 0, "the dialog to close");
        expect(ui.close).toHaveBeenCalledWith(false);
      } finally {
        ui.cleanup();
      }
    });

    test("the level menu says what each level means and can remove the row", async () => {
      const ui = await renderDialog();
      // A checked choice elsewhere on the page must not take the menu's focus.
      const page = ui.dom.document.createElement("div");
      page.setAttribute("role", "radio");
      page.setAttribute("aria-checked", "true");
      page.tabIndex = 0;
      ui.dom.document.body.prepend(page);
      try {
        ui.row("Lea Schmitt").querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click();
        const menu = () => ui.row("Lea Schmitt").querySelector<HTMLElement>('[role="dialog"]');
        await waitFor(() => menu()?.contains(ui.dom.document.activeElement) === true, "the focus in the menu");
        expect(ui.dom.document.activeElement?.getAttribute("aria-checked")).toBe("true");
        expect(ui.dom.document.activeElement?.textContent).toContain("View");
        expect(menu()?.textContent).toContain("Sees the content.");
        expect(menu()?.textContent).toContain("Adds and changes content.");
        expect(menu()?.textContent).toContain("Also changes settings and access.");
        Array.from(menu()!.querySelectorAll<HTMLButtonElement>("button"))
          .find((item) => item.textContent?.trim() === "Remove")!
          .click();
        await waitFor(() => ui.row("Lea Schmitt").textContent?.includes("Will be removed") === true, "the removal mark");
        expect(menu()).toBeNull();
      } finally {
        ui.cleanup();
      }
    });

    test("all signed-in people says agents and service accounts need their own access", async () => {
      const ui = await renderDialog();
      try {
        ui.dom.root.querySelector<HTMLInputElement>('input[aria-label="All signed-in people"]')!.click();
        await waitFor(() => ui.text().includes("1 change"), "the change");
        expect(ui.row("All signed-in people").textContent).toContain("Agents and service accounts need their own access.");
      } finally {
        ui.cleanup();
      }
    });
  });
});
