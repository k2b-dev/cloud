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
    const choose = (name: string, level: string) => chooseLevel(row(name), level);
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
      serviceAccountKind: "resource_bound",
    };
    const field = (ui: Awaited<ReturnType<typeof setup>>) =>
      ui.dom.root.querySelector<HTMLInputElement>('input[aria-label="Identifier of the service account"]');
    const openAdding = async (ui: Awaited<ReturnType<typeof setup>>) => {
      ui.button("Add service account").click();
      await waitFor(() => !!field(ui), "the identifier field");
    };
    const cancelAdding = async (ui: Awaited<ReturnType<typeof setup>>) => {
      Array.from(field(ui)!.closest("form")!.querySelectorAll<HTMLButtonElement>("button"))
        .find((item) => item.textContent?.trim() === "Cancel")!
        .click();
      await waitFor(() => !field(ui), "the identifier field to close");
    };
    const empty = "No service account yet. Code of a mailbox or a base gets access here like a person.";
    const note =
      "Code runs as the service account of its object. Whoever manages “Einkauf 2027” gives it access here, like a person. Whoever edits the code acts with this right.";

    test("without rows: the empty text, the identifier hint, and nothing while adding", async () => {
      const ui = await setup({ entries: [mia], findServiceAccount: async () => null });
      try {
        const text = () => ui.dom.root.textContent ?? "";
        expect(text()).toContain(empty);
        expect(text()).not.toContain("Code runs as the service account");
        await openAdding(ui);
        expect(field(ui)!.placeholder).toBe("Identifier from the code page, for example code-7k2q9m4xwt");
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

    test("a found account with a picture shows it in the preview", async () => {
      const ui = await setup({
        entries: [mia],
        findServiceAccount: async () => ({
          principal: { type: "service_account", serviceAccountId: "20000000-0000-4000-8000-000000000011" },
          display: { displayName: "Code von info@beispiel.de", avatarHash: "abc123", serviceAccountKind: "resource_bound" },
        }),
      });
      try {
        await openAdding(ui);
        const input = field(ui)!;
        input.value = "code-7k2q9m4xwt";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        ui.button("Find").click();
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
        // General is not known yet either, so it does not claim "Off".
        expect(ui.text()).not.toContain("All signed-in people");
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
