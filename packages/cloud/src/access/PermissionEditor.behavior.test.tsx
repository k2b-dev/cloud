import { describe, expect, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import type { AccessEntry, Principal, ServiceAccountKind } from "../contracts/shared";

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
        await waitFor(() => rowOf("Found agent") !== undefined, "the new agent row");
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
