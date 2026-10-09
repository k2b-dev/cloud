import { expect, test } from "bun:test";
import type { AccessEntry } from "@k2b/cloud/contracts/shared";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

/** happy-dom has no Popover API; the level menus open through it. */
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

const manager = (id: string, displayName: string): AccessEntry => ({
  id,
  principal: { type: "user", userId: `user-${id}` },
  permission: "admin",
  createdAt: "2026-10-06T00:00:00.000Z",
  displayName,
});

domTest("the base access editor turns read-only once a change costs the person Manage access", async () => {
  const dom = createDomTestHarness();
  installPopoverApi(dom);
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = (input instanceof Request ? input.method : init?.method) ?? "GET";
      requests.push(`${method} ${new URL(url, "http://cloud.test").pathname}`);
      // Lowering their own entry left the person with Edit, and only managers may list the entries.
      if (method === "PATCH") return new Response(null, { status: 204 });
      return Response.json({ message: "You no longer have administrator access to this Base." }, { status: 403 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { ScopedPermissionEditor } = await import("./ScopedPermissionEditor");
  delegateEvents(["click"]);
  const dispose = render(
    () => (
      <ScopedPermissionEditor
        scope={{ type: "base", id: "BASE01" }}
        initialEntries={[manager("qdt", "Quentin Dorn"), manager("lym", "Lya Meyer")]}
        canEdit
      />
    ),
    dom.root,
  );
  const rowOf = (name: string) =>
    Array.from(dom.root.querySelectorAll<HTMLElement>(".group\\/access-row")).find((row) => row.textContent?.includes(name))!;
  const removeButtons = () => dom.root.querySelectorAll("button[aria-label^='Remove ']");
  try {
    expect(removeButtons()).toHaveLength(2);
    const edit = Array.from(rowOf("Quentin Dorn").querySelectorAll<HTMLButtonElement>("[role=menuitemradio]")).find((item) =>
      item.textContent?.startsWith("Edit"),
    )!;
    edit.click();

    await waitFor(() => removeButtons().length === 0, "the read-only editor");
    expect(requests).toEqual(["PATCH /api/grids/access/qdt", "GET /api/grids/access/by-base/BASE01"]);
    expect(rowOf("Quentin Dorn").querySelector("[role=menuitemradio]")).toBeNull();
    expect(rowOf("Quentin Dorn").textContent).toContain("Edit");
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

const entry = (
  id: string,
  principal: AccessEntry["principal"],
  permission: AccessEntry["permission"],
  displayName: string,
): AccessEntry => ({
  id,
  principal,
  permission,
  createdAt: "2026-10-06T00:00:00.000Z",
  displayName,
});
const qdt = { type: "user", userId: "user-qdt" } as const;
const lym = { type: "user", userId: "user-lym" } as const;
const staff = { type: "group", groupId: "group-staff" } as const;
const interns = { type: "group", groupId: "group-interns" } as const;

// The same grants as access-last-manager.integration.test.ts, where the service refuses exactly these rows.
const precedenceCases: { name: string; entries: AccessEntry[]; locked: string[] }[] = [
  {
    name: "a duplicate none grant shadows the second manager",
    entries: [
      entry("qdt", qdt, "admin", "Quentin Dorn"),
      entry("lym", lym, "admin", "Lya Meyer"),
      entry("lym-deny", lym, "none", "Lya Meyer (denied)"),
    ],
    locked: ["qdt"],
  },
  {
    name: "a group deny shadows the group's own Manage grant",
    entries: [
      entry("qdt", qdt, "admin", "Quentin Dorn"),
      entry("staff", staff, "admin", "Staff"),
      entry("staff-deny", staff, "none", "Staff (denied)"),
    ],
    locked: ["qdt"],
  },
  {
    name: "a deny for another group shadows nothing",
    entries: [entry("staff", staff, "admin", "Staff"), entry("interns-deny", interns, "none", "Interns")],
    locked: ["staff"],
  },
  {
    name: "two unshadowed managers",
    entries: [entry("qdt", qdt, "admin", "Quentin Dorn"), entry("lym", lym, "admin", "Lya Meyer")],
    locked: [],
  },
];

for (const scenario of precedenceCases) {
  domTest(`the base access editor locks exactly the rows the service refuses: ${scenario.name}`, async () => {
    const dom = createDomTestHarness();
    installPopoverApi(dom);
    const originalFetch = globalThis.fetch;
    // Group rows load their members; the directory withholds them here.
    globalThis.fetch = Object.assign(async () => new Response(null, { status: 403 }), { preconnect: originalFetch.preconnect });
    const { ScopedPermissionEditor } = await import("./ScopedPermissionEditor");
    const dispose = render(
      () => <ScopedPermissionEditor scope={{ type: "base", id: "BASE01" }} initialEntries={scenario.entries} canEdit />,
      dom.root,
    );
    const rowOf = (name: string) =>
      Array.from(dom.root.querySelectorAll<HTMLElement>(".group\\/access-row")).find((row) =>
        row.querySelector(`button[aria-label="Remove ${name}"]`),
      )!;
    try {
      const locked = scenario.entries
        .filter((item) => rowOf(item.displayName!).querySelector<HTMLButtonElement>("button[aria-label^='Remove ']")!.disabled)
        .map((item) => item.id);
      expect(locked).toEqual(scenario.locked);
      for (const item of scenario.entries.filter((candidate) => candidate.permission === "admin")) {
        const lower = Array.from(rowOf(item.displayName!).querySelectorAll<HTMLButtonElement>("[role=menuitemradio]")).filter(
          (option) => !option.textContent?.startsWith("Manage"),
        );
        expect(lower.every((option) => option.disabled)).toBe(scenario.locked.includes(item.id));
      }
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
}
