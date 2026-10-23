import { describe, expect, setSystemTime, test } from "bun:test";
import { createSignal, Show } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import type { AccessEntry, Principal, ServiceAccountKind } from "../contracts/shared";
import type { GrantableLevel } from "./PermissionEditor";

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

/** happy-dom has no Popover API; the picker's result list opens through it. */
const installPopoverApi = (dom: DomTestHarness) => {
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
};

const labels = {
  en: {
    agent: "Agent",
    standalone: "Service account",
    resource_bound: "Resource-bound service account",
    user_delegated: "User-bound service account",
  },
  de: {
    agent: "Agent",
    standalone: "Dienstkonto",
    resource_bound: "Ressourcengebundenes Dienstkonto",
    user_delegated: "Benutzergebundenes Dienstkonto",
  },
} as const;
const icons: Record<ServiceAccountKind, string> = {
  agent: "ti-robot",
  standalone: "ti-key",
  resource_bound: "ti-box",
  user_delegated: "ti-user-key",
};
const kinds = Object.keys(icons) as ServiceAccountKind[];

const serviceEntry = (kind?: ServiceAccountKind): AccessEntry => ({
  id: `access-${kind ?? "unknown"}`,
  principal: { type: "service_account", serviceAccountId: `granted-${kind ?? "unknown"}` },
  permission: "read",
  createdAt: "2026-09-30T00:00:00.000Z",
  displayName: `Granted ${kind ?? "unknown"}`,
  ...(kind ? { serviceAccountKind: kind } : {}),
});
const binding = (kind: ServiceAccountKind) =>
  kind === "resource_bound"
    ? { appId: "contacts", resourceType: "book", resourceId: "book-1" }
    : { appId: null, resourceType: null, resourceId: null };

describe("PermissionEditor expanded interactions", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  for (const locale of ["en", "de"] as const) {
    test(`${locale}: clearing a selection and adding return focus to principal search`, async () => {
      const dom = createDomTestHarness();
      installPopoverApi(dom);
      dom.document.documentElement.lang = locale;
      setSystemTime(new Date("2026-10-22T12:00:00.000Z"));
      const { default: PermissionEditor } = await import("./PermissionEditor");
      delegateEvents(["input", "click"], dom.document);
      const dispose = render(
        () => (
          <PermissionEditor
            expanded
            initialEntries={[]}
            grantAccess={async (principal, permission, display) => ({
              id: "new-grant",
              principal,
              permission,
              createdAt: "2026-10-22T12:00:00.000Z",
              ...display,
            })}
            updateAccess={async () => {}}
            revokeAccess={async () => {}}
          />
        ),
        dom.root,
      );
      const pick = async () => {
        const input = dom.root.querySelector<HTMLInputElement>("input[role=combobox]")!;
        input.focus();
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const results = () => dom.document.getElementById(input.getAttribute("aria-controls")!);
        await waitFor(() => !!results()?.querySelector("[role=option]"), "the signed-in audience");
        results()!.querySelector<HTMLButtonElement>("[role=option]")!.click();
        await waitFor(
          () => !!dom.root.querySelector('button[aria-label^="Auswahl entfernen:"], button[aria-label^="Remove selection:"]'),
          "the selected principal",
        );
      };
      try {
        await pick();
        const clear = dom.root.querySelector<HTMLButtonElement>(
          locale === "de" ? 'button[aria-label^="Auswahl entfernen:"]' : 'button[aria-label^="Remove selection:"]',
        )!;
        expect(clear).not.toBeNull();
        clear.focus();
        clear.click();
        await waitFor(() => dom.document.activeElement === dom.root.querySelector("input[role=combobox]"), "focus after clearing");
        await pick();
        const add = Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find(
          (button) => button.textContent === (locale === "de" ? "Hinzufügen" : "Add"),
        )!;
        add.focus();
        add.click();
        await waitFor(() => !!dom.root.querySelector(".group\\/access-row:not([aria-busy])"), "the confirmed grant");
        await waitFor(() => dom.document.activeElement === dom.root.querySelector("input[role=combobox]"), "focus after adding");
      } finally {
        dispose();
        setSystemTime();
        dom.cleanup();
      }
    });
  }

  test("a blocked expanded editor leaves failure explanation to its caller and offers no row retry", async () => {
    const dom = createDomTestHarness();
    installPopoverApi(dom);
    const { default: PermissionEditor } = await import("./PermissionEditor");
    delegateEvents(["click"], dom.document);
    const [canEdit, setCanEdit] = createSignal(true);
    let attempts = 0;
    const dispose = render(
      () => (
        <PermissionEditor
          expanded
          initialEntries={[serviceEntry("standalone")]}
          canEdit={canEdit()}
          grantAccess={async () => {
            throw new Error("Not used");
          }}
          updateAccess={async () => {
            attempts += 1;
            throw new Error("The change could not be confirmed.");
          }}
          revokeAccess={async () => {}}
        />
      ),
      dom.root,
    );
    try {
      const row = dom.root.querySelector<HTMLElement>(".group\\/access-row")!;
      Array.from(row.querySelectorAll<HTMLButtonElement>('[role="option"]'))
        .find((option) => option.textContent?.includes("Edit"))!
        .click();
      await waitFor(() => !!dom.root.querySelector('[role="alert"] button'), "the retry action");
      setCanEdit(false);
      expect(dom.root.querySelector('[role="alert"]')).toBeNull();
      expect(attempts).toBe(1);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("re-enabled editing drops failed changes and retries but keeps rows, confirmations and the selection", async () => {
    const dom = createDomTestHarness();
    installPopoverApi(dom);
    const { default: PermissionEditor } = await import("./PermissionEditor");
    delegateEvents(["input", "click"], dom.document);
    const [canEdit, setCanEdit] = createSignal(true);
    let attempts = 0;
    const dispose = render(
      () => (
        <PermissionEditor
          expanded
          initialEntries={[serviceEntry("standalone"), serviceEntry("agent")]}
          canEdit={canEdit()}
          grantAccess={async () => {
            throw new Error("Not used");
          }}
          updateAccess={async (accessId) => {
            attempts += 1;
            if (accessId === "access-standalone") throw new Error("Another manager must remain.");
          }}
          revokeAccess={async () => {}}
        />
      ),
      dom.root,
    );
    try {
      const rows = Array.from(dom.root.querySelectorAll<HTMLElement>(".group\\/access-row"));
      const chooseEdit = (row: HTMLElement) =>
        Array.from(row.querySelectorAll<HTMLButtonElement>('[role="option"]'))
          .find((option) => option.textContent?.includes("Edit"))!
          .click();
      chooseEdit(rows[1]!);
      await waitFor(() => !!rows[1]!.querySelector(".ti-check.text-success"), "the confirmed change");
      chooseEdit(rows[0]!);
      await waitFor(() => !!dom.root.querySelector('[role="alert"] button'), "the retry action");
      const input = dom.root.querySelector<HTMLInputElement>("input[role=combobox]")!;
      input.focus();
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const results = () => dom.document.getElementById(input.getAttribute("aria-controls")!);
      await waitFor(() => !!results()?.querySelector("[role=option]"), "the signed-in audience");
      results()!.querySelector<HTMLButtonElement>("[role=option]")!.click();
      await waitFor(() => !!dom.root.querySelector('button[aria-label^="Remove selection:"]'), "the selection");
      setCanEdit(false);
      setCanEdit(true);
      // An unchanged list after a canonical read: the same rows stay mounted, only the stale failure goes.
      const after = Array.from(dom.root.querySelectorAll(".group\\/access-row"));
      expect(after.length === rows.length && after.every((row, index) => row === rows[index])).toBe(true);
      expect(dom.root.querySelector('[role="alert"]')).toBeNull();
      expect(rows[1]!.querySelector(".ti-check.text-success")).not.toBeNull();
      expect(dom.root.querySelector('button[aria-label^="Remove selection:"]')).not.toBeNull();
      expect(attempts).toBe(2);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("own markers and service subtitles belong to expanded rows only", async () => {
    const dom = createDomTestHarness();
    const { default: PermissionEditor } = await import("./PermissionEditor");
    const [expanded, setExpanded] = createSignal(true);
    const entry = serviceEntry("agent");
    const dispose = render(
      () => (
        <PermissionEditor
          expanded={expanded()}
          ownEntryIds={[entry.id]}
          initialEntries={[entry]}
          canEdit={false}
          grantAccess={async () => {
            throw new Error("Not used");
          }}
          updateAccess={async () => {}}
          revokeAccess={async () => {}}
        />
      ),
      dom.root,
    );
    try {
      const row = dom.root.querySelector<HTMLElement>(".group\\/access-row")!;
      expect(row.children[1]?.textContent).toContain("Agent · you");
      expect(row.textContent).not.toContain("(Agent)");
      expect(row.children[1]?.firstElementChild?.textContent).toBe("Granted agent");
      setExpanded(false);
      expect(row.textContent).not.toContain(" · you");
      expect(row.textContent).toContain("(Agent)");
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});

describe("PermissionEditor service accounts", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  for (const locale of ["en", "de"] as const) {
    test(`${locale}: rows, picker results, and a new grant show the same kind`, async () => {
      const dom = createDomTestHarness();
      installPopoverApi(dom);
      dom.document.documentElement.lang = locale;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        async () =>
          Response.json({
            items: kinds.map((kind) => ({
              kind: "service_account",
              serviceAccount: { id: `found-${kind}`, name: `Found ${kind}`, kind, ...binding(kind) },
            })),
          }),
        { preconnect: originalFetch.preconnect },
      );
      const { default: PermissionEditor } = await import("./PermissionEditor");
      delegateEvents(["input", "click"]);
      const rowOf = (name: string) =>
        Array.from(dom.root.querySelectorAll<HTMLElement>(".group\\/access-row")).find((row) => row.textContent?.includes(name));
      const granted: { principal: Principal; kind?: ServiceAccountKind }[] = [];
      const returned: AccessEntry[] = [];
      const dispose = render(
        () => (
          <PermissionEditor
            initialEntries={[...kinds.map(serviceEntry), serviceEntry()]}
            allowAuthenticated={false}
            allowServiceAccounts
            // A deferred draft builds its entry from the display metadata the picker hands over.
            grantAccess={async (principal, permission, display) => {
              granted.push({ principal, kind: display?.serviceAccountKind });
              const entry: AccessEntry = { id: "access-new", principal, permission, createdAt: "2026-09-30T00:00:00.000Z", ...display };
              returned.push(entry);
              return entry;
            }}
            updateAccess={async () => {}}
            revokeAccess={async () => {}}
          />
        ),
        dom.root,
      );
      try {
        for (const kind of kinds) {
          const row = rowOf(`Granted ${kind}`)!;
          expect(row.querySelector(`i.${icons[kind]}`)).not.toBeNull();
          expect(row.textContent).toContain(`(${labels[locale][kind]})`);
        }
        // An entry whose consumer did not resolve the kind makes no claim about it.
        const unknown = rowOf("Granted unknown")!;
        expect(unknown.querySelector("i.ti-key")).not.toBeNull();
        expect(unknown.textContent).not.toContain("(");

        const input = dom.root.querySelector<HTMLInputElement>("input[role=combobox]")!;
        input.value = "fo";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await waitFor(() => dom.root.querySelectorAll("[role=option]").length === kinds.length, "the service-account results");
        const options = Array.from(dom.root.querySelectorAll<HTMLButtonElement>("[role=option]"));
        for (const kind of kinds) {
          const option = options.find((element) => element.textContent?.includes(`Found ${kind}`))!;
          expect(option.querySelector(`i.${icons[kind]}`)).not.toBeNull();
          // Resource-bound accounts often share a name, so their result shows the binding instead.
          expect(option.querySelector("small")?.textContent).toBe(
            kind === "resource_bound" ? "contacts · book · book-1" : labels[locale][kind],
          );
        }

        options.find((element) => element.textContent?.includes("Found agent"))!.click();
        await waitFor(() => rowOf("Found agent")?.hasAttribute("aria-busy") === false, "the granted agent row");
        expect(granted).toEqual([{ principal: { type: "service_account", serviceAccountId: "found-agent" }, kind: "agent" }]);
        const added = rowOf("Found agent")!;
        expect(added.querySelector("i.ti-robot")).not.toBeNull();
        expect(added.textContent).toContain(`(${labels[locale].agent})`);

        // The editor changes its own copy; the entry the caller returned stays as the caller made it.
        const edit = locale === "de" ? "Bearbeiten" : "Edit";
        Array.from(added.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]"))
          .find((item) => item.textContent?.startsWith(edit))!
          .click();
        await waitFor(() => rowOf("Found agent")?.textContent?.includes(edit) === true, "the new level");
        expect(returned.map((entry) => entry.permission)).toEqual(["read"]);
      } finally {
        dispose();
        globalThis.fetch = originalFetch;
        dom.cleanup();
      }
    });
  }

  test("a kind this bundle does not know shows a key without a label", async () => {
    const dom = createDomTestHarness();
    installPopoverApi(dom);
    const originalFetch = globalThis.fetch;
    // Core may add a kind before an independently deployed app updates its bundle.
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({
          items: [
            {
              kind: "service_account",
              serviceAccount: {
                id: "found-later",
                name: "Found later",
                kind: "added_later",
                appId: null,
                resourceType: null,
                resourceId: null,
              },
            },
          ],
        }),
      { preconnect: originalFetch.preconnect },
    );
    const { default: PermissionEditor } = await import("./PermissionEditor");
    delegateEvents(["input", "click"]);
    const dispose = render(
      () => (
        <PermissionEditor
          initialEntries={[]}
          allowAuthenticated={false}
          allowServiceAccounts
          grantAccess={async (principal, permission, display) => ({
            id: "access-new",
            principal,
            permission,
            createdAt: "2026-09-30T00:00:00.000Z",
            ...display,
          })}
          updateAccess={async () => {}}
          revokeAccess={async () => {}}
        />
      ),
      dom.root,
    );
    try {
      const input = dom.root.querySelector<HTMLInputElement>("input[role=combobox]")!;
      input.value = "fo";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(() => dom.root.querySelectorAll("[role=option]").length === 1, "the service-account result");
      const option = dom.root.querySelector<HTMLButtonElement>("[role=option]")!;
      expect(option.querySelector("i.ti-key")).not.toBeNull();
      expect(option.querySelector("small")).toBeNull();

      option.click();
      const rowOf = () =>
        Array.from(dom.root.querySelectorAll<HTMLElement>(".group\\/access-row")).find((row) => row.textContent?.includes("Found later"));
      await waitFor(() => rowOf() !== undefined, "the new row");
      expect(rowOf()!.querySelector("i.ti-key")).not.toBeNull();
      expect(rowOf()!.textContent).not.toContain("(");
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
});

const grant = (id: string, principal: Principal, permission: AccessEntry["permission"], displayName?: string): AccessEntry => ({
  id,
  principal,
  permission,
  createdAt: "2026-10-06T00:00:00.000Z",
  ...(displayName ? { displayName } : {}),
});

describe("PermissionEditor last manager", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("keeps the only manager's row from being lowered or removed until another manager exists", async () => {
    const dom = createDomTestHarness();
    installPopoverApi(dom);
    dom.document.documentElement.lang = "de";
    const { default: PermissionEditor } = await import("./PermissionEditor");
    delegateEvents(["click"]);
    const updates: { accessId: string; permission: string }[] = [];
    const initialEntries: AccessEntry[] = [
      grant("qdt", { type: "user", userId: "user-qdt" }, "admin", "Quentin Dorn"),
      grant("lym", { type: "user", userId: "user-lym" }, "read", "Lya Meyer"),
      // A resource-bound key never stands in for the last person who can manage.
      {
        ...grant("key", { type: "service_account", serviceAccountId: "key" }, "admin", "Import key"),
        serviceAccountKind: "resource_bound",
      },
      // The server's English audience name gives way to the localized label.
      grant("all", { type: "authenticated" }, "read", "All users (incl. guests)"),
    ];
    const dispose = render(
      () => (
        <PermissionEditor
          initialEntries={initialEntries}
          allowServiceAccounts
          grantAccess={async () => {
            throw new Error("Not used by this test.");
          }}
          updateAccess={async (accessId, permission) => {
            updates.push({ accessId, permission });
          }}
          revokeAccess={async () => {}}
        />
      ),
      dom.root,
    );
    const rowOf = (name: string) =>
      Array.from(dom.root.querySelectorAll<HTMLElement>(".group\\/access-row")).find((row) => row.textContent?.includes(name))!;
    const removeButton = (name: string) => rowOf(name).querySelector<HTMLButtonElement>(`button[aria-label="${name} entfernen"]`)!;
    // The level menu of each row stays in the document as a closed popover.
    const levelsOf = (name: string) => Array.from(rowOf(name).querySelectorAll<HTMLButtonElement>("[role=menuitemradio]"));
    try {
      expect(rowOf("Alle Benutzer einschließlich Gäste")).toBeDefined();
      expect(dom.root.textContent).not.toContain("All users (incl. guests)");

      expect(removeButton("Quentin Dorn").disabled).toBe(true);
      expect(removeButton("Quentin Dorn").getAttribute("aria-description")).toStartWith(
        "Der letzte Eintrag mit Zugriff „Verwalten“ kann nicht herabgestuft oder entfernt werden.",
      );
      expect(removeButton("Lya Meyer").disabled).toBe(false);
      expect(removeButton("Lya Meyer").hasAttribute("aria-description")).toBe(false);
      expect(removeButton("Import key").disabled).toBe(false);
      const locked = levelsOf("Quentin Dorn");
      expect(locked.map((item) => [item.textContent?.startsWith("Verwalten") ?? false, item.disabled])).toEqual([
        [false, true],
        [false, true],
        [true, false],
      ]);
      expect(locked[0]!.textContent).toContain("Möglich, sobald eine weitere Person oder Gruppe Zugriff „Verwalten“ hat");

      // Once a second person can manage, both rows can change again.
      const levels = levelsOf("Lya Meyer");
      expect(levels.every((item) => !item.disabled)).toBe(true);
      levels.find((item) => item.textContent?.startsWith("Verwalten"))!.click();
      await waitFor(() => !removeButton("Quentin Dorn").disabled, "the unlocked manager row");
      expect(removeButton("Quentin Dorn").hasAttribute("aria-description")).toBe(false);
      expect(updates).toEqual([{ accessId: "lym", permission: "admin" }]);
      expect(removeButton("Lya Meyer").disabled).toBe(false);
      // The caller's entries keep what was stored; the editor changed only its own copy.
      expect(initialEntries.map((entry) => entry.permission)).toEqual(["admin", "read", "admin", "read"]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("counts managers only among the entries the resource's precedence leaves in effect", async () => {
    const dom = createDomTestHarness();
    installPopoverApi(dom);
    const { default: PermissionEditor } = await import("./PermissionEditor");
    delegateEvents(["click"]);
    const lym = { type: "user", userId: "user-lym" } as const;
    const dispose = render(
      () => (
        <PermissionEditor
          initialEntries={[
            grant("qdt", { type: "user", userId: "user-qdt" }, "admin", "Quentin Dorn"),
            grant("lym", lym, "admin", "Lya Meyer"),
            grant("lym-deny", lym, "none", "Lya Meyer (denied)"),
            grant("ana", { type: "user", userId: "user-ana" }, "read", "Ana Roth"),
          ]}
          // A deny overrides every grant of the same principal, as the resource's service decides.
          effectiveEntries={(entries) => {
            const denied = new Set(entries.filter((entry) => entry.permission === "none").map((entry) => JSON.stringify(entry.principal)));
            return entries.filter((entry) => !denied.has(JSON.stringify(entry.principal)));
          }}
          grantAccess={async () => {
            throw new Error("Not used by this test.");
          }}
          updateAccess={async () => {}}
          revokeAccess={async () => {}}
        />
      ),
      dom.root,
    );
    const removeButton = (name: string) => dom.root.querySelector<HTMLButtonElement>(`button[aria-label="Remove ${name}"]`)!;
    const rowOf = (name: string) => removeButton(name).closest<HTMLElement>(".group\\/access-row")!;
    try {
      // Lya's Manage grant is shadowed, so Quentin is the only manager the service still counts.
      expect(removeButton("Quentin Dorn").disabled).toBe(true);
      expect(removeButton("Lya Meyer").disabled).toBe(false);
      expect(removeButton("Lya Meyer (denied)").disabled).toBe(false);

      // The function sees the editor's current entries, so a new manager unlocks the row.
      Array.from(rowOf("Ana Roth").querySelectorAll<HTMLButtonElement>("[role=menuitemradio]"))
        .find((item) => item.textContent?.startsWith("Manage"))!
        .click();
      await waitFor(() => !removeButton("Quentin Dorn").disabled, "the unlocked manager row");
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});

describe("PermissionEditor scoped levels", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("offers a level on part of the resource next to the whole-resource levels and reports the scope", async () => {
    const dom = createDomTestHarness();
    installPopoverApi(dom);
    const { default: PermissionEditor } = await import("./PermissionEditor");
    delegateEvents(["click"]);
    const updates: { accessId: string; permission: string; scope?: string }[] = [];
    const dispose = render(
      () => (
        <PermissionEditor
          initialEntries={[
            grant("qdt", { type: "user", userId: "user-qdt" }, "admin", "Quentin Dorn"),
            { ...grant("lym", { type: "user", userId: "user-lym" }, "read", "Lya Meyer"), scope: "assigned" },
            grant("ana", { type: "user", userId: "user-ana" }, "read", "Ana Roth"),
          ]}
          allowedLevels={[
            "read",
            "write",
            "admin",
            { level: "read", scope: "assigned", label: "Assigned: view", icon: "ti-user-check", description: "Only what is assigned" },
            { level: "write", scope: "assigned", label: "Assigned: edit", icon: "ti-user-edit" },
          ]}
          grantAccess={async () => {
            throw new Error("Not used by this test.");
          }}
          updateAccess={async (accessId, permission, scope) => {
            updates.push({ accessId, permission, ...(scope ? { scope } : {}) });
          }}
          revokeAccess={async () => {}}
        />
      ),
      dom.root,
    );
    const rowOf = (name: string) =>
      Array.from(dom.root.querySelectorAll<HTMLElement>(".group\\/access-row")).find((row) => row.textContent?.includes(name))!;
    const levelsOf = (name: string) => Array.from(rowOf(name).querySelectorAll<HTMLButtonElement>("[role=menuitemradio]"));
    const chosen = (name: string) => levelsOf(name).find((item) => item.getAttribute("aria-checked") === "true")?.textContent ?? "";
    try {
      // The same level reads as its scoped option only on the scoped grant.
      expect(chosen("Lya Meyer")).toStartWith("Assigned: view");
      expect(chosen("Ana Roth")).toStartWith("View");
      expect(levelsOf("Ana Roth").find((item) => item.textContent?.startsWith("Assigned: view"))?.textContent).toContain(
        "Only what is assigned",
      );
      // A grant on part of the resource never manages it: the only whole-resource manager stays locked to Manage.
      expect(
        levelsOf("Quentin Dorn")
          .filter((item) => !item.disabled)
          .map((item) => item.textContent?.slice(0, 6)),
      ).toEqual(["Manage"]);

      levelsOf("Ana Roth")
        .find((item) => item.textContent?.startsWith("Assigned: edit"))!
        .click();
      await waitFor(() => !rowOf("Ana Roth").hasAttribute("aria-busy"), "the saved scoped level");
      expect(chosen("Ana Roth")).toStartWith("Assigned: edit");
      levelsOf("Lya Meyer")
        .find((item) => item.textContent?.startsWith("View"))!
        .click();
      await waitFor(() => !rowOf("Lya Meyer").hasAttribute("aria-busy"), "the saved whole-resource level");
      expect(chosen("Lya Meyer")).toStartWith("View");
      expect(updates).toEqual([
        { accessId: "ana", permission: "write", scope: "assigned" },
        { accessId: "lym", permission: "read" },
      ]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});

const directoryUser = (index: number) => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  uid: `member${index}`,
  roles: ["user"],
  provider: "ipa",
  profile: "user",
  givenname: "Member",
  sn: String(index),
  displayName: `Member ${index}`,
  mail: null,
  avatarHash: null,
});

describe("PermissionEditor group coverage", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const groupId = "33333333-3333-4333-8333-333333333333";
  const directoryGroup = {
    items: [
      {
        kind: "group",
        group: { id: groupId, provider: "ipa", name: "venue-crew", description: null, gidnumber: null, personalOwner: null },
      },
    ],
    pagination: { page: 1, per_page: 1, total: 1, total_pages: 1, has_next: false },
  };
  /** Answers member pages from `members`; `fail` decides which page requests fail. */
  const memberPages =
    (members: ReturnType<typeof directoryUser>[], fail: (page: number) => boolean = () => false) =>
    (url: URL) => {
      if (url.searchParams.has("group_ids")) return Response.json(directoryGroup);
      const page = Number(url.searchParams.get("page"));
      const perPage = Number(url.searchParams.get("per_page"));
      if (fail(page)) return Response.json({ code: "INTERNAL", message: "Unavailable" }, { status: 500 });
      return Response.json({
        items: members.slice((page - 1) * perPage, page * perPage).map((user) => ({ kind: "user", user, relation: { direct: true } })),
        pagination: {
          page,
          per_page: perPage,
          total: members.length,
          total_pages: Math.ceil(members.length / perPage),
          has_next: page * perPage < members.length,
        },
      });
    };
  const renderGroup = async (dom: DomTestHarness, respond: (url: URL) => Response) => {
    const requests: URL[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        requests.push(url);
        return respond(url);
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: PermissionEditor } = await import("./PermissionEditor");
    delegateEvents(["click"]);
    const dispose = render(
      () => (
        <PermissionEditor
          initialEntries={[
            grant("owner", { type: "user", userId: "user-owner" }, "admin", "Owner"),
            grant("venue-crew", { type: "group", groupId }, "read", "venue-crew"),
          ]}
          grantAccess={async () => {
            throw new Error("Not used by this test.");
          }}
          updateAccess={async () => {}}
          revokeAccess={async () => {}}
        />
      ),
      dom.root,
    );
    // The level menu trigger also controls a popup; the member toggle does not open one.
    const toggle = () => dom.root.querySelector<HTMLButtonElement>("button[aria-controls]:not([aria-haspopup])")!;
    const groupRow = () => toggle().closest<HTMLElement>(".group\\/access-row")!;
    const panel = () => dom.document.getElementById(toggle().getAttribute("aria-controls")!)!;
    const button = (label: string) => Array.from(panel().querySelectorAll("button")).find((element) => element.textContent === label);
    return {
      requests,
      groupRow,
      // Captured before any request can answer: the row as it first renders.
      initialRow: groupRow().outerHTML,
      toggle,
      panel,
      button,
      done: () => {
        dispose();
        globalThis.fetch = originalFetch;
      },
    };
  };

  test("lists the people a group grant reaches page by page, without changing the row", async () => {
    const dom = createDomTestHarness();
    installPopoverApi(dom);
    dom.document.documentElement.lang = "en";
    const view = await renderGroup(dom, memberPages(Array.from({ length: 23 }, (_, index) => directoryUser(index + 1))));
    try {
      expect(view.panel().textContent).toContain("Loading members…");
      await waitFor(() => view.panel().querySelectorAll("li").length === 20, "the first page");
      // Coverage follows access resolution: direct and nested members, users only.
      const memberRequest = view.requests.find((url) => url.searchParams.has("member_of_group_id"))!;
      expect(Object.fromEntries(memberRequest.searchParams)).toEqual({
        kinds: "user",
        member_of_group_id: groupId,
        recursive: "true",
        page: "1",
        per_page: "20",
      });
      // Loading changes nothing in the row, so nothing in it can move.
      expect(view.groupRow().outerHTML).toBe(view.initialRow);
      expect(view.toggle().textContent).toBe("Members");
      expect(view.toggle().getAttribute("aria-label")).toBe("Members of venue-crew");
      expect(view.toggle().getAttribute("aria-expanded")).toBe("false");
      expect(view.panel().hidden).toBe(true);

      view.toggle().click();
      expect(view.toggle().getAttribute("aria-expanded")).toBe("true");
      expect(view.panel().hidden).toBe(false);
      // The count leads the list, then the directory hint.
      expect(Array.from(view.panel().children, (child) => child.textContent)).toEqual([
        "23 people receive access through this group right now.",
        "This group comes from the directory. Local accounts such as guests can't be members, so give them access directly.",
        expect.stringContaining("Member 1"),
        "Show 3 more",
      ]);
      expect(view.panel().querySelector("ul")?.getAttribute("aria-label")).toBe("Members of venue-crew");

      const more = view.button("Show 3 more")!;
      more.focus();
      more.click();
      await waitFor(() => view.panel().querySelectorAll("li").length === 23, "the second page");
      // The button leaves once everything is shown; keyboard focus stays in the list.
      await waitFor(() => dom.document.activeElement === view.panel().querySelector("ul"), "focus in the completed list");
      expect(Array.from(view.panel().querySelectorAll("button")).some((element) => element.textContent?.includes("more"))).toBe(false);

      // Changing the group's level keeps its row, and with it the open list.
      Array.from(view.groupRow().querySelectorAll<HTMLButtonElement>("[role=menuitemradio]"))
        .find((item) => item.textContent?.startsWith("Edit"))!
        .click();
      await waitFor(() => view.groupRow().textContent?.includes("Edit") === true, "the new level");
      expect(view.toggle().getAttribute("aria-expanded")).toBe("true");
      expect(view.panel().querySelectorAll("li")).toHaveLength(23);
      expect(
        view.requests.filter((url) => url.searchParams.get("page") === "1" && url.searchParams.has("member_of_group_id")),
      ).toHaveLength(1);
    } finally {
      view.done();
      dom.cleanup();
    }
  });

  test("keeps keyboard focus where the viewer can continue when a page fails", async () => {
    const dom = createDomTestHarness();
    installPopoverApi(dom);
    dom.document.documentElement.lang = "en";
    let failures = 1;
    const view = await renderGroup(
      dom,
      memberPages(
        Array.from({ length: 45 }, (_, index) => directoryUser(index + 1)),
        (page) => page === 3 && failures-- > 0,
      ),
    );
    try {
      await waitFor(() => view.button("Show 20 more") !== undefined, "the first page");
      view.toggle().click();

      // A page that loads keeps focus on the button for the rest.
      view.button("Show 20 more")!.focus();
      view.button("Show 20 more")!.click();
      await waitFor(() => view.panel().querySelectorAll("li").length === 40, "the second page");
      await waitFor(() => dom.document.activeElement === view.button("Show 5 more"), "focus on the next page button");

      // A failed page removes the button; focus moves to the retry, and the failure is announced.
      view.button("Show 5 more")!.click();
      await waitFor(() => view.panel().querySelector("[role=alert]") !== null, "the failure");
      expect(view.panel().querySelector("[role=alert]")?.textContent).toBe("Members couldn't be loaded. Try again");
      await waitFor(() => dom.document.activeElement === view.button("Try again"), "focus on the retry");

      view.button("Try again")!.click();
      await waitFor(() => dom.document.activeElement === view.button("Show 5 more"), "focus back on the page button");
      expect(view.panel().querySelector("[role=alert]")).toBeNull();
      expect(view.panel().querySelectorAll("li")).toHaveLength(40);
    } finally {
      view.done();
      dom.cleanup();
    }
  });

  test("shows no member data when the directory withholds it", async () => {
    const dom = createDomTestHarness();
    installPopoverApi(dom);
    dom.document.documentElement.lang = "de";
    const view = await renderGroup(dom, (url) =>
      url.searchParams.has("member_of_group_id")
        ? Response.json({ code: "FORBIDDEN", message: "Guest accounts cannot use entity relation filters" }, { status: 403 })
        : Response.json({ items: [], pagination: { page: 1, per_page: 1, total: 0, total_pages: 0, has_next: false } }),
    );
    try {
      await waitFor(() => view.panel().textContent?.includes("Dein Konto kann nicht sehen") === true, "the withheld note");
      expect(view.groupRow().outerHTML).toBe(view.initialRow);
      view.toggle().click();
      expect(view.panel().hidden).toBe(false);
      expect(view.toggle().textContent).toBe("Mitglieder");
      expect(view.toggle().getAttribute("aria-label")).toBe("Mitglieder von Venue-Crew");
      expect(view.panel().querySelector("ul")).toBeNull();
      expect(view.panel().textContent).not.toContain("Über diese Gruppe");
      expect(view.panel().textContent).not.toContain("Verzeichnis");
    } finally {
      view.done();
      dom.cleanup();
    }
  });
});

describe("PermissionEditor pending grants", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const renderEditor = async () => {
    const dom = createDomTestHarness();
    installPopoverApi(dom);
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        fetchCalls += 1;
        return Response.json({
          items: ["Jonas Weber", "Lea Sommer"].map((displayName, index) => ({
            kind: "user",
            user: { id: `user-${index}`, uid: `user-${index}`, displayName, mail: null },
          })),
        });
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: PermissionEditor } = await import("./PermissionEditor");
    const grants: { resolve: (entry: AccessEntry) => void; reject: (error: Error) => void; entry: AccessEntry }[] = [];
    setSystemTime(new Date("2026-10-15T07:00:00.000Z"));
    delegateEvents(["input", "click", "keydown"], dom.document);
    const dispose = render(
      () => (
        <PermissionEditor
          initialEntries={[grant("manager", { type: "user", userId: "mara" }, "admin", "Mara Lind")]}
          allowedLevels={["admin", "read"]}
          allowAuthenticated={false}
          grantAccess={(principal, permission, display) =>
            new Promise<AccessEntry>((resolve, reject) => {
              grants.push({ resolve, reject, entry: grant(`real-${grants.length}`, principal, permission, display?.displayName) });
            })
          }
          updateAccess={async () => {}}
          revokeAccess={async () => {}}
        />
      ),
      dom.root,
    );
    const rows = () => Array.from(dom.root.querySelectorAll<HTMLElement>(".group\\/access-row"));
    const rowOf = (name: string) => rows().find((row) => row.textContent?.includes(name));
    const input = dom.root.querySelector<HTMLInputElement>("input[role=combobox]")!;
    const pick = async (name: string) => {
      input.focus();
      input.value = name.slice(0, 2);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(
        () =>
          input.getAttribute("aria-expanded") === "true" &&
          Array.from(dom.root.querySelectorAll("[role=option]")).some((option) => option.textContent?.includes(name)),
        "the user result",
      );
      Array.from(dom.root.querySelectorAll<HTMLButtonElement>("[role=option]"))
        .find((option) => option.textContent?.includes(name))!
        .click();
      return grants.length;
    };
    return {
      dom,
      grants,
      fetchCalls: () => fetchCalls,
      rows,
      rowOf,
      input,
      pick,
      dispose,
      done: async () => {
        dispose();
        // Close the error prompt before restoring the DOM globals.
        dom.document.querySelector<HTMLButtonElement>("dialog button")?.click();
        await Bun.sleep(10);
        globalThis.fetch = originalFetch;
        setSystemTime();
        dom.cleanup();
      },
    };
  };

  test("a pending grant keeps focus and blocks new picks until it finishes", async () => {
    const view = await renderEditor();
    const { dom, grants, rows, rowOf, input, pick } = view;
    const disabledChanges: MutationRecord[] = [];
    const observer = new MutationObserver((records) => disabledChanges.push(...records));
    observer.observe(input, { attributes: true, attributeFilter: ["disabled"] });
    try {
      // Capture the call count during selection, before a queued microtask could start.
      expect(await pick("Jonas Weber")).toBe(1);
      const firstRow = rowOf("Jonas Weber")!;
      expect(firstRow).toBeDefined();
      expect(firstRow.getAttribute("aria-busy")).toBe("true");
      expect(firstRow.querySelector("button.k2b-select-chip .ti-loader-2.k2b-spin")).not.toBeNull();
      expect(firstRow.textContent).toContain("Manage");
      expect(grants).toHaveLength(1);
      expect(input.disabled).toBe(false);
      expect(input.readOnly).toBe(true);
      expect(input.getAttribute("aria-readonly")).toBe("true");
      expect(dom.document.activeElement).toBe(input);
      for (const row of rows()) {
        expect(row.querySelector<HTMLButtonElement>('button[aria-label^="Remove "]')!.disabled).toBe(true);
        expect(row.querySelector<HTMLButtonElement>("button.k2b-select-chip")!.disabled).toBe(true);
      }
      // A pending manager cannot unlock the only saved manager.
      expect(rowOf("Mara Lind")!.querySelector<HTMLButtonElement>('button[aria-label="Remove Mara Lind"]')!.disabled).toBe(true);
      const requests = view.fetchCalls();
      input.value = "Le";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      input.click();
      await Bun.sleep(200);
      expect(input.value).toBe("");
      expect(input.getAttribute("aria-expanded")).toBe("false");
      expect(view.fetchCalls()).toBe(requests);
      expect(rowOf("Lea Sommer")).toBeUndefined();
      expect(grants).toHaveLength(1);

      grants[0]!.resolve(grants[0]!.entry);
      await waitFor(() => rowOf("Jonas Weber")?.hasAttribute("aria-busy") === false, "the final row");
      expect(rowOf("Jonas Weber")).toBe(firstRow);
      expect(rows()).toHaveLength(2);
      expect(firstRow.querySelector("button.k2b-select-chip .ti-loader-2.k2b-spin")).toBeNull();
      expect(firstRow.querySelector<HTMLButtonElement>('button[aria-label="Remove Jonas Weber"]')!.disabled).toBe(false);
      expect(input.readOnly).toBe(false);
      expect(input.hasAttribute("aria-readonly")).toBe(false);
      expect(dom.document.activeElement).toBe(input);
      await waitFor(() => dom.document.querySelector("[data-k2b-live]")?.textContent?.includes("Jonas Weber") === true, "the announcement");

      await pick("Lea Sommer");
      expect(grants).toHaveLength(2);
      expect(rowOf("Lea Sommer")!.getAttribute("aria-busy")).toBe("true");
      expect(input.readOnly).toBe(true);
      grants[1]!.resolve(grants[1]!.entry);
      await waitFor(() => rowOf("Lea Sommer")?.hasAttribute("aria-busy") === false, "the second final row");
      expect(input.readOnly).toBe(false);
      expect(dom.document.activeElement).toBe(input);
      expect(rows().map((row) => row.querySelector(".truncate")?.textContent)).toEqual(["Mara Lind", "Jonas Weber", "Lea Sommer"]);
      expect(disabledChanges).toHaveLength(0);
    } finally {
      observer.disconnect();
      await view.done();
    }
  });

  test("a failed grant removes its row, shows the error, and makes the picker editable", async () => {
    const view = await renderEditor();
    const { dom, grants, rowOf, input, pick } = view;
    try {
      await pick("Jonas Weber");
      expect(rowOf("Jonas Weber")!.getAttribute("aria-busy")).toBe("true");
      grants[0]!.reject(new Error("Grant was refused"));
      await waitFor(() => !rowOf("Jonas Weber"), "the failed row to disappear");
      await waitFor(
        () => dom.document.querySelector("dialog[open]")?.textContent?.includes("Grant was refused") === true,
        "the error prompt",
      );
      expect(input.disabled).toBe(false);
      expect(input.readOnly).toBe(false);
      expect(input.hasAttribute("aria-readonly")).toBe(false);
      expect(dom.document.querySelectorAll("[data-k2b-live]")).toHaveLength(0);
      dom.document.querySelector<HTMLButtonElement>("dialog button")!.click();
      await pick("Jonas Weber");
      expect(grants).toHaveLength(2);
      grants[1]!.resolve(grants[1]!.entry);
      await waitFor(() => rowOf("Jonas Weber")?.hasAttribute("aria-busy") === false, "the retried grant");
    } finally {
      await view.done();
    }
  });

  test("ignores stale duplicate options while pending and after success", async () => {
    const view = await renderEditor();
    const { dom, grants, rows, rowOf, pick } = view;
    try {
      await pick("Jonas Weber");
      expect(rowOf("Jonas Weber")!.getAttribute("aria-busy")).toBe("true");
      const stale = dom.root.querySelector<HTMLButtonElement>("[role=option]")!;
      stale.click();
      expect(rows()).toHaveLength(2);
      expect(grants).toHaveLength(1);
      grants[0]!.resolve(grants[0]!.entry);
      await waitFor(() => rowOf("Jonas Weber")?.hasAttribute("aria-busy") === false, "the saved grant");
      // Before another lookup replaces the options, the old result still exists.
      stale.click();
      expect(rows()).toHaveLength(2);
      expect(grants).toHaveLength(1);
    } finally {
      await view.done();
    }
  });

  test("an AbortError removes its pending row without a prompt", async () => {
    const view = await renderEditor();
    const { dom, grants, rowOf, input, pick } = view;
    try {
      await pick("Jonas Weber");
      expect(rowOf("Jonas Weber")!.getAttribute("aria-busy")).toBe("true");
      grants[0]!.reject(new DOMException("Grant was cancelled", "AbortError"));
      await waitFor(() => !rowOf("Jonas Weber"), "the cancelled row to disappear");
      expect(input.readOnly).toBe(false);
      expect(input.disabled).toBe(false);
      expect(dom.document.activeElement).toBe(input);
      expect(dom.document.querySelector("dialog[open]")).toBeNull();
      expect(dom.document.querySelectorAll("[data-k2b-live]")).toHaveLength(0);
    } finally {
      await view.done();
    }
  });

  for (const fail of [false, true]) {
    test(`after disposal a late grant ${fail ? "failure still shows its error" : "success stays silent"}`, async () => {
      const view = await renderEditor();
      const { dom, grants, pick } = view;
      try {
        await pick("Jonas Weber");
        expect(view.rowOf("Jonas Weber")?.getAttribute("aria-busy")).toBe("true");
        view.dispose();
        if (fail) grants[0]!.reject(new Error("Late grant failure"));
        else grants[0]!.resolve(grants[0]!.entry);
        await Bun.sleep(10);
        // Closing the dialog while the grant saves must not hide that it failed.
        expect(dom.document.querySelector("dialog[open]")?.textContent?.includes("Late grant failure") === true).toBe(fail);
        expect(dom.document.querySelectorAll("[data-k2b-live]")).toHaveLength(0);
        expect(grants).toHaveLength(1);
      } finally {
        await view.done();
      }
    });
  }
});

describe("PermissionEditor pending controls", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const deferred = <T = void,>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return {
      promise,
      resolve,
      reject,
      // Await the controlled continuation before asserting the mutation's resulting state.
      settle: async (value: T) => {
        resolve(value);
        await promise;
      },
    };
  };

  const setup = async (
    options: { expanded?: boolean; beforeChange?: (entry: AccessEntry, next: GrantableLevel | null) => Promise<boolean> } = {},
  ) => {
    const dom = createDomTestHarness();
    installPopoverApi(dom);
    const { default: PermissionEditor } = await import("./PermissionEditor");
    const { prompts } = await import("@k2b/ui");
    const update = deferred();
    const revoke = deferred();
    const [canEdit, setCanEdit] = createSignal(true);
    const writes: string[] = [];
    const originalConfirm = prompts.confirm;
    const originalError = prompts.error;
    const errors: string[] = [];
    prompts.confirm = async () => true;
    prompts.error = async (message) => {
      errors.push(String(message));
    };
    delegateEvents(["click"], dom.document);
    const dispose = render(
      () => (
        <PermissionEditor
          expanded={options.expanded}
          beforeChange={options.beforeChange}
          canEdit={canEdit()}
          initialEntries={[
            grant("manager", { type: "user", userId: "mara" }, "admin", "Mara Lind"),
            grant("lea", { type: "user", userId: "lea" }, "read", "Lea Sommer"),
            grant("jonas", { type: "user", userId: "jonas" }, "read", "Jonas Weber"),
          ]}
          grantAccess={async () => {
            throw new Error("Not used");
          }}
          updateAccess={(id) => {
            writes.push(`update:${id}`);
            return update.promise;
          }}
          revokeAccess={(id) => {
            writes.push(`revoke:${id}`);
            return revoke.promise;
          }}
        />
      ),
      dom.root,
    );
    const rows = Array.from(dom.root.querySelectorAll<HTMLElement>(".group\\/access-row"));
    const pickerSelector = options.expanded ? 'button[role="combobox"]' : "button.k2b-select-chip";
    const triggers = rows.map((row) => row.querySelector<HTMLButtonElement>(pickerSelector)!);
    const removes = rows.map((row) => row.querySelector<HTMLButtonElement>('button[aria-label^="Remove "]')!);
    const assertControls = (disabled: boolean) => {
      rows.forEach((row, index) => {
        expect(row.querySelector(pickerSelector) === triggers[index]!).toBe(true);
        expect(triggers[index]!.disabled).toBe(disabled);
        expect(row.querySelector("span.cursor-default")).toBeNull();
      });
    };
    const chooseEdit = () =>
      Array.from(rows[1]!.querySelectorAll<HTMLButtonElement>("[role=menuitemradio], [role=option]"))
        .find((item) => item.textContent?.startsWith("Edit"))!
        .click();
    return {
      dom,
      update,
      revoke,
      rows,
      triggers,
      removes,
      writes,
      setCanEdit,
      dispose,
      errors,
      assertControls,
      chooseEdit,
      done: () => {
        dispose();
        prompts.confirm = originalConfirm;
        prompts.error = originalError;
        dom.cleanup();
      },
    };
  };

  for (const expanded of [false, true]) {
    for (const action of ["update", "revoke"] as const) {
      test(`${expanded ? "expanded" : "compact"}: ${action} confirmation keeps controls enabled but blocks duplicate writes through saving`, async () => {
        const confirmation = deferred<boolean>();
        const confirmations: (GrantableLevel | null)[] = [];
        const view = await setup({
          expanded,
          beforeChange: (_entry, next) => {
            confirmations.push(next);
            return confirmation.promise;
          },
        });
        const attempt = () => {
          view.chooseEdit();
          view.removes[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        };
        try {
          if (action === "update") view.chooseEdit();
          else view.removes[1]!.click();
          expect(confirmations).toEqual([action === "update" ? "write" : null]);
          view.assertControls(false);
          expect(view.removes[1]!.disabled).toBe(false);
          expect(view.dom.root.querySelector<HTMLInputElement>('input[role="combobox"]')!.disabled).toBe(false);
          expect(view.rows.every((row) => !row.hasAttribute("aria-busy"))).toBe(true);
          attempt();
          expect(confirmations).toHaveLength(1);
          expect(view.writes).toEqual([]);

          await confirmation.settle(true);
          expect(view.writes).toEqual([`${action}:lea`]);
          view.assertControls(true);
          expect(view.removes[1]!.disabled).toBe(true);
          attempt();
          expect(confirmations).toHaveLength(1);
          expect(view.writes).toEqual([`${action}:lea`]);
          await view[action].settle();
          expect(view.triggers[2]!.disabled).toBe(false);
          expect(view.writes).toEqual([`${action}:lea`]);
        } finally {
          view.done();
        }
      });
    }
  }

  for (const action of ["update", "revoke"] as const) {
    test(`an expanded ${action} retry cannot bypass another row's confirmation lock`, async () => {
      const firstConfirmation = deferred<boolean>();
      const nextConfirmation = deferred<boolean>();
      let confirmations = 0;
      const view = await setup({
        expanded: true,
        beforeChange: () => (++confirmations === 1 ? firstConfirmation.promise : nextConfirmation.promise),
      });
      try {
        if (action === "update") view.chooseEdit();
        else view.removes[1]!.click();
        await firstConfirmation.settle(true);
        expect(view.writes).toEqual([`${action}:lea`]);
        view[action].reject(new Error("Could not save access"));
        await view[action].promise.catch(() => {});
        const retry = view.dom.root.querySelector<HTMLButtonElement>('[role="alert"] button')!;
        expect(retry).not.toBeNull();
        view.removes[2]!.click();
        expect(confirmations).toBe(2);
        expect(retry.disabled).toBe(false);
        retry.click();
        expect(confirmations).toBe(2);
        expect(view.writes).toEqual([`${action}:lea`]);
        await nextConfirmation.settle(false);
        expect(view.writes).toEqual([`${action}:lea`]);
      } finally {
        view.done();
      }
    });

    for (const invalidation of ["permission revoked", "disposed"] as const) {
      test(`${action} does not write when ${invalidation} before confirmation resolves`, async () => {
        const confirmation = deferred<boolean>();
        let confirmations = 0;
        const view = await setup({
          beforeChange: () => {
            confirmations += 1;
            return confirmation.promise;
          },
        });
        try {
          if (action === "update") view.chooseEdit();
          else view.removes[1]!.click();
          expect(confirmations).toBe(1);
          expect(view.writes).toEqual([]);
          if (invalidation === "disposed") view.dispose();
          else view.setCanEdit(false);
          await confirmation.settle(true);
          expect(view.writes).toEqual([]);
          expect(confirmations).toBe(1);
        } finally {
          view.done();
        }
      });
    }
  }

  test("a pending update keeps every picker and shows progress and the chosen level only on its row", async () => {
    const view = await setup();
    try {
      view.assertControls(false);
      view.chooseEdit();
      view.assertControls(true);
      expect(view.rows.map((row) => row.getAttribute("aria-busy"))).toEqual([null, "true", null]);
      expect(view.triggers.map((chip) => chip.querySelectorAll(".ti-loader-2.k2b-spin").length)).toEqual([0, 1, 0]);
      expect(view.triggers[1]!.textContent).toBe("Edit");
      view.update.resolve();
      await waitFor(() => !view.rows[1]!.hasAttribute("aria-busy"), "the saved update");
      view.assertControls(false);
      expect(view.triggers[1]!.textContent).toBe("Edit");
      expect(view.dom.root.querySelector(".ti-loader-2")).toBeNull();
    } finally {
      view.done();
    }
  });

  test("a failed update restores the stored level and enables the same pickers with an error", async () => {
    const view = await setup();
    try {
      view.chooseEdit();
      expect(view.triggers[1]!.textContent).toBe("Edit");
      view.assertControls(true);
      view.update.reject(new Error("Could not save access"));
      await waitFor(() => !view.rows[1]!.hasAttribute("aria-busy"), "the failed update");
      view.assertControls(false);
      expect(view.triggers[1]!.textContent).toBe("View");
      expect(view.errors).toEqual(["Could not save access"]);
    } finally {
      view.done();
    }
  });

  test("a confirmed pending revoke loads only its remove button and keeps every picker", async () => {
    const view = await setup();
    try {
      const remove = view.rows.map((row) => row.querySelector<HTMLButtonElement>('button[aria-label^="Remove "]')!);
      remove[1]!.focus();
      remove[1]!.click();
      await waitFor(() => remove[1]!.getAttribute("aria-busy") === "true", "the confirmed revoke");
      view.assertControls(true);
      expect(view.rows.map((row) => row.getAttribute("aria-busy"))).toEqual([null, "true", null]);
      expect(remove.map((button) => button.querySelectorAll(".ti-loader-2").length)).toEqual([0, 1, 0]);
      expect(view.triggers.map((chip) => chip.querySelectorAll(".ti-loader-2").length)).toEqual([0, 0, 0]);
      view.revoke.resolve();
      await waitFor(() => !view.rows[1]!.isConnected, "the removed row");
      // Focus continues at the next row instead of falling back to the page.
      await waitFor(() => view.dom.document.activeElement === remove[2], "focus on the next row");
      for (const index of [0, 2]) {
        expect(view.rows[index]!.querySelector("button.k2b-select-chip") === view.triggers[index]!).toBe(true);
        expect(view.triggers[index]!.disabled).toBe(false);
      }
    } finally {
      view.done();
    }
  });
});

describe("PermissionEditor caller refreshes", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const setup = async () => {
    const dom = createDomTestHarness();
    installPopoverApi(dom);
    setSystemTime(new Date("2026-10-17T12:00:00.000Z"));
    const { default: PermissionEditor } = await import("./PermissionEditor");
    const { prompts } = await import("@k2b/ui");
    const originalConfirm = prompts.confirm;
    prompts.confirm = async () => true;
    const initial = [
      grant("lea", { type: "user", userId: "lea" }, "read", "Lea Sommer"),
      grant("jonas", { type: "user", userId: "jonas" }, "read", "Jonas Weber"),
    ];
    const [data, setData] = createSignal(initial);
    let finishUpdate!: () => void;
    let finishRevoke!: () => void;
    delegateEvents(["click"], dom.document);
    const dispose = render(
      () => (
        <Show when={data()}>
          {(entries) => (
            <PermissionEditor
              initialEntries={entries().filter(() => true)}
              grantAccess={async () => {
                throw new Error("Not used");
              }}
              updateAccess={() =>
                new Promise<void>((resolve) => {
                  finishUpdate = resolve;
                })
              }
              revokeAccess={() =>
                new Promise<void>((resolve) => {
                  finishRevoke = resolve;
                })
              }
            />
          )}
        </Show>
      ),
      dom.root,
    );
    const chips = () => Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button.k2b-select-chip"));
    const chooseEdit = (index = 0) => {
      const row = chips()[index]!.closest(".group\\/access-row")!;
      Array.from(row.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]"))
        .find((item) => item.textContent?.startsWith("Edit"))!
        .click();
    };
    return {
      initial,
      data,
      setData,
      chips,
      chooseEdit,
      finishUpdate: () => finishUpdate(),
      revokeFirst: () => dom.root.querySelector<HTMLButtonElement>('button[aria-label="Remove Lea Sommer"]')!.click(),
      revokeStarted: () => typeof finishRevoke === "function",
      finishRevoke: () => finishRevoke(),
      done: () => {
        dispose();
        prompts.confirm = originalConfirm;
        setSystemTime();
        dom.cleanup();
      },
    };
  };

  test("fresh caller objects merge changed and added entries without replacing existing chips", async () => {
    const view = await setup();
    try {
      const originals = view.chips();
      view.setData([
        ...view.initial.map((entry, index) => ({ ...entry, permission: index === 1 ? ("write" as const) : entry.permission })),
        grant("mara", { type: "user", userId: "mara" }, "admin", "Mara Lind"),
      ]);
      await waitFor(() => view.chips().length === 3, "the refetched entries");
      originals.forEach((chip, index) => expect(view.chips()[index] === chip).toBe(true));
      expect(view.chips().map((chip) => chip.textContent)).toEqual(["View", "Edit", "Manage"]);
    } finally {
      view.done();
    }
  });

  test("defers the latest caller list until an update finishes without undoing the saved level", async () => {
    const view = await setup();
    try {
      const originals = view.chips();
      view.chooseEdit();
      const refetched = view.initial.map((entry) => ({ ...entry, permission: "write" as const }));
      view.setData(refetched);
      await Promise.resolve();
      expect(view.chips()[0]!.disabled).toBe(true);
      expect(view.chips()[1]!.textContent).toBe("View");
      view.setData([...refetched, grant("mara", { type: "user", userId: "mara" }, "read", "Mara Lind")]);
      expect(view.chips()).toHaveLength(2);
      view.finishUpdate();
      await waitFor(() => view.chips().length === 3 && !view.chips()[0]!.disabled, "the idle merge");
      originals.forEach((chip, index) => expect(view.chips()[index] === chip).toBe(true));
      expect(view.chips().map((chip) => chip.textContent)).toEqual(["Edit", "Edit", "View"]);
      expect(refetched.map((entry) => entry.permission)).toEqual(["write", "write"]);
    } finally {
      view.done();
    }
  });

  test("a caller refresh during an update wins over the requested level and keeps the same chip", async () => {
    const view = await setup();
    try {
      const original = view.chips()[0]!;
      view.chooseEdit();
      expect(original.textContent).toBe("Edit");
      expect(original.disabled).toBe(true);
      const refetched = view.initial.map((entry, index) => ({ ...entry, permission: index === 0 ? ("admin" as const) : entry.permission }));
      view.setData(refetched);
      expect(view.chips()[0]).toBe(original);
      expect(original.textContent).toBe("Edit");
      view.finishUpdate();
      await waitFor(() => !original.disabled, "the update callbacks to finish");
      expect(view.chips()[0]).toBe(original);
      expect(original.textContent).toBe("Manage");
      view.setData(refetched.map((entry) => ({ ...entry })));
      expect(original.textContent).toBe("Manage");
    } finally {
      view.done();
    }
  });

  test("a caller refresh during a revoke wins over local filtering and keeps unaffected chips", async () => {
    const view = await setup();
    try {
      const survivor = view.chips()[1]!;
      view.revokeFirst();
      await waitFor(view.revokeStarted, "the confirmed revoke");
      // The later snapshot includes renewed access and another person's changed permission.
      view.setData(view.initial.map((entry, index) => ({ ...entry, permission: index === 0 ? ("admin" as const) : ("write" as const) })));
      expect(view.chips().map((chip) => chip.textContent)).toEqual(["View", "View"]);
      expect(survivor.disabled).toBe(true);
      view.finishRevoke();
      await waitFor(() => !survivor.disabled, "the revoke callbacks to finish");
      expect(view.chips().map((chip) => chip.textContent)).toEqual(["Manage", "Edit"]);
      expect(view.chips()[1]).toBe(survivor);
    } finally {
      view.done();
    }
  });

  test("re-evaluating an unchanged caller list does not revert a successful local update", async () => {
    const view = await setup();
    try {
      view.chooseEdit();
      view.finishUpdate();
      await waitFor(() => !view.chips()[0]!.disabled, "the saved local update");
      view.setData(view.initial.map((entry) => ({ ...entry })));
      await Promise.resolve();
      expect(view.chips()[0]!.textContent).toBe("Edit");
    } finally {
      view.done();
    }
  });

  test("a stale caller list acknowledging one saved update preserves another saved update and both chips", async () => {
    const view = await setup();
    try {
      const originals = view.chips();
      view.chooseEdit(1);
      view.finishUpdate();
      await waitFor(() => !originals[1]!.disabled, "the first saved update");
      // This refetch started before the next update and only saw the first one.
      const stale = view.initial.map((entry, index) => ({ ...entry, permission: index === 1 ? ("write" as const) : entry.permission }));
      view.chooseEdit();
      view.finishUpdate();
      await waitFor(() => !originals[0]!.disabled, "the second saved update");
      view.setData(stale);
      await Promise.resolve();
      expect(view.chips().map((chip) => chip.textContent)).toEqual(["Edit", "Edit"]);
      originals.forEach((chip, index) => expect(view.chips()[index]).toBe(chip));
      expect(stale.map((entry) => entry.permission)).toEqual(["read", "write"]);
    } finally {
      view.done();
    }
  });

  test("a stale caller list with another changed row does not restore a confirmed local revoke", async () => {
    const view = await setup();
    try {
      const survivor = view.chips()[1]!;
      view.revokeFirst();
      await waitFor(view.revokeStarted, "the confirmed revoke");
      view.finishRevoke();
      await waitFor(() => view.chips().length === 1 && !survivor.disabled, "the saved revoke");
      view.setData(view.initial.map((entry, index) => ({ ...entry, permission: index === 1 ? ("write" as const) : entry.permission })));
      await Promise.resolve();
      expect(view.chips()).toHaveLength(1);
      expect(view.chips()[0]).toBe(survivor);
      expect(survivor.textContent).toBe("Edit");
    } finally {
      view.done();
    }
  });

  test("a caller list removes a row present in the base and keeps the surviving chip", async () => {
    const view = await setup();
    try {
      const originals = view.chips();
      view.setData([{ ...view.initial[1]! }]);
      await waitFor(() => view.chips().length === 1, "the caller removal");
      expect(originals[0]!.isConnected).toBe(false);
      expect(view.chips()[0]).toBe(originals[1]!);
    } finally {
      view.done();
    }
  });

  test("never writes local changes into mount or subsequently applied caller objects", async () => {
    const view = await setup();
    try {
      const initialSnapshot = JSON.stringify(view.initial);
      const refetched = view.initial.map((entry) => ({ ...entry, displayName: `${entry.displayName} refreshed` }));
      const refetchedSnapshot = JSON.stringify(refetched);
      view.setData(refetched);
      view.chooseEdit();
      view.finishUpdate();
      await waitFor(() => !view.chips()[0]!.disabled, "the saved update after a merge");
      expect(view.chips()[0]!.textContent).toBe("Edit");
      expect(JSON.stringify(view.initial)).toBe(initialSnapshot);
      expect(JSON.stringify(refetched)).toBe(refetchedSnapshot);
    } finally {
      view.done();
    }
  });
});

describe("PermissionEditor principal names", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
  const assertNoIds = (root: HTMLElement) => {
    expect(root.textContent).not.toMatch(uuid);
    for (const element of root.querySelectorAll("[aria-label], [aria-description], [title]")) {
      for (const attribute of ["aria-label", "aria-description", "title"]) expect(element.getAttribute(attribute) ?? "").not.toMatch(uuid);
    }
  };
  for (const locale of ["en", "de"] as const) {
    test(`${locale}: unnamed principals have localized labels, named rows keep names and initials`, async () => {
      const dom = createDomTestHarness();
      dom.document.documentElement.lang = locale;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(async () => Response.json({ items: [], pagination: { total: 0, has_next: false } }), {
        preconnect: originalFetch.preconnect,
      });
      const { default: PermissionEditor } = await import("./PermissionEditor");
      const entries: AccessEntry[] = [
        { id: id(1), principal: { type: "user", userId: id(2) }, permission: "read", createdAt: "2026-10-20T12:00:00.000Z" },
        { id: id(3), principal: { type: "group", groupId: id(4) }, permission: "read", createdAt: "2026-10-20T12:00:00.000Z" },
        {
          id: id(5),
          principal: { type: "service_account", serviceAccountId: id(6) },
          serviceAccountKind: "agent",
          permission: "admin",
          createdAt: "2026-10-20T12:00:00.000Z",
        },
        { id: id(7), principal: { type: "authenticated" }, permission: "read", createdAt: "2026-10-20T12:00:00.000Z" },
        { id: id(8), principal: { type: "public" }, permission: "read", createdAt: "2026-10-20T12:00:00.000Z" },
        {
          id: id(9),
          principal: { type: "user", userId: id(10) },
          displayName: "Ada Example",
          permission: "admin",
          createdAt: "2026-10-20T12:00:00.000Z",
        },
        {
          id: id(11),
          principal: { type: "group", groupId: id(12) },
          displayName: "finance-team",
          permission: "read",
          createdAt: "2026-10-20T12:00:00.000Z",
        },
      ];
      const dispose = render(
        () => (
          <PermissionEditor
            initialEntries={entries}
            grantAccess={async () => {
              throw new Error("unused");
            }}
            updateAccess={async () => {}}
            revokeAccess={async () => {}}
          />
        ),
        dom.root,
      );
      try {
        assertNoIds(dom.root);
        for (const label of locale === "en"
          ? ["Unknown person", "Deleted group", "Unknown agent", "All users (including guests)", "Public", "finance-team"]
          : [
              "Unbekannte Person",
              "Gelöschte Gruppe",
              "Unbekannter Agent",
              "Alle Benutzer einschließlich Gäste",
              "Öffentlich",
              "Finance-Team",
            ])
          expect(dom.root.textContent).toContain(label);
        const row = Array.from(dom.root.querySelectorAll<HTMLElement>(".group\\/access-row")).find((row) =>
          row.textContent?.includes("Ada Example"),
        )!;
        expect(row.textContent).toContain("AE");
        const unknown = Array.from(dom.root.querySelectorAll<HTMLElement>(".group\\/access-row"))[0]!;
        expect(unknown.textContent).toContain("UP");
      } finally {
        dispose();
        globalThis.fetch = originalFetch;
        dom.cleanup();
      }
    });

    test(`${locale}: an unresolved grant retains the picked name and avatar`, async () => {
      const dom = createDomTestHarness();
      installPopoverApi(dom);
      dom.document.documentElement.lang = locale;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        async () =>
          Response.json({
            items: [
              { kind: "user", user: { id: id(20), uid: "ada", displayName: "Ada Example", avatarHash: "avatar-revision", mail: null } },
            ],
          }),
        { preconnect: originalFetch.preconnect },
      );
      setSystemTime(new Date("2026-10-20T12:00:00.000Z"));
      const { default: PermissionEditor } = await import("./PermissionEditor");
      delegateEvents(["input", "click"], dom.document);
      let granted = false;
      const dispose = render(
        () => (
          <PermissionEditor
            initialEntries={[]}
            allowAuthenticated={false}
            grantAccess={async (principal, permission) => {
              granted = true;
              return { id: id(21), principal, permission, createdAt: "2026-10-20T12:00:00.000Z" };
            }}
            updateAccess={async () => {}}
            revokeAccess={async () => {}}
          />
        ),
        dom.root,
      );
      try {
        const input = dom.root.querySelector<HTMLInputElement>("input[role=combobox]")!;
        input.value = "Ada";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await waitFor(() => !!dom.root.querySelector("[role=option]"), "the picked person");
        dom.root.querySelector<HTMLButtonElement>("[role=option]")!.click();
        await waitFor(() => granted && !!dom.root.querySelector(".group\\/access-row:not([aria-busy])"), "the saved row");
        assertNoIds(dom.root);
        expect(dom.root.textContent).toContain("Ada Example");
        expect(dom.root.querySelector("img")?.getAttribute("src")).toContain("avatar-revision");
      } finally {
        dispose();
        globalThis.fetch = originalFetch;
        setSystemTime();
        dom.cleanup();
      }
    });
  }
});
