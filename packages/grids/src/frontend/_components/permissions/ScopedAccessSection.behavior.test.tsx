import { expect, test } from "bun:test";
import type { AccessEntry, Principal } from "@k2b/cloud/contracts/shared";
import { delegateEvents, isServer, render } from "solid-js/web";
import { precedenceScenarios, type ScenarioPrincipal } from "@/access-precedence.test-fixture";
import { createDomTestHarness, type DomTestHarness } from "../../../../../ui/test/dom";

/** Opens a row's level menu and picks a level, as a person would. */
const chooseLevel = (row: Element, level: string) => {
  row.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click();
  Array.from(row.querySelectorAll<HTMLElement>('[role="radio"]'))
    .find((option) => option.textContent?.includes(level))!
    .click();
};

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

/** Opens the access dialog from the section and returns it. */
const openDialog = async (dom: DomTestHarness) => {
  Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent?.trim() === "Edit access")!
    .click();
  await waitFor(() => !!dom.document.querySelector('[role="dialog"] input[role=combobox]'), "the access dialog");
  return dom.document.querySelector<HTMLElement>('[role="dialog"]')!;
};
const closeDialog = async (dom: DomTestHarness) => {
  const dialog = dom.document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) return;
  Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent?.trim() === "Cancel")
    ?.click();
  await waitFor(() => !dom.document.querySelector('[role="dialog"]'), "the dialog to close");
};

domTest("the base access section turns read-only once a saved change costs the person Manage access", async () => {
  const dom = createDomTestHarness();
  dom.document.documentElement.lang = "en";
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
      return Response.json({ message: "You no longer have administrator access to this base." }, { status: 403 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { ScopedAccessSection } = await import("./ScopedAccessSection");
  delegateEvents(["click", "input"], dom.document);
  const dispose = render(
    () => (
      <ScopedAccessSection
        scope={{ type: "base", id: "BASE01" }}
        resourceName="Projects"
        title="Base access"
        initialEntries={[manager("qdt", "Quentin Dorn"), manager("lym", "Lya Meyer")]}
        canEdit
      />
    ),
    dom.root,
  );
  const editButton = () =>
    Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === "Edit access");
  try {
    const dialog = await openDialog(dom);
    const row = Array.from(dialog.querySelectorAll("li")).find((item) => item.textContent?.includes("Quentin Dorn"))!;
    chooseLevel(row, "Edit");
    await waitFor(() => dialog.textContent?.includes("1 change") === true, "one change");
    Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Save")!
      .click();
    await waitFor(() => !editButton(), "the read-only section");
    expect(requests).toEqual(["PATCH /api/grids/access/qdt", "GET /api/grids/access/by-base/BASE01"]);
    // The saved change still shows, although the list could not be read again.
    const listed = Array.from(dom.root.querySelectorAll<HTMLElement>(".group\\/access-row")).find((item) =>
      item.textContent?.includes("Quentin Dorn"),
    )!;
    expect(listed.textContent).toContain("Edit");
  } finally {
    await closeDialog(dom);
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

const scenarioPrincipal = ({ type, name }: ScenarioPrincipal): Principal =>
  type === "user" ? { type, userId: name } : { type, groupId: name };

for (const scenario of precedenceScenarios) {
  domTest(`the base access dialog locks exactly the rows the service refuses: ${scenario.name}`, async () => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    installPopoverApi(dom);
    const originalFetch = globalThis.fetch;
    // Group rows load their members; the directory withholds them here.
    globalThis.fetch = Object.assign(async () => new Response(null, { status: 403 }), { preconnect: originalFetch.preconnect });
    const { ScopedAccessSection } = await import("./ScopedAccessSection");
    delegateEvents(["click", "input"], dom.document);
    const entries: AccessEntry[] = scenario.grants.map((grant) => ({
      id: grant.key,
      principal: scenarioPrincipal(grant.principal),
      permission: grant.permission,
      createdAt: "2026-10-06T00:00:00.000Z",
      displayName: grant.principal.name,
    }));
    const dispose = render(
      () => (
        <ScopedAccessSection
          scope={{ type: "base", id: "BASE01" }}
          resourceName="Projects"
          title="Base access"
          initialEntries={entries}
          canEdit
        />
      ),
      dom.root,
    );
    try {
      const dialog = await openDialog(dom);
      // Every entry is its own row, in the order of the entries, also when one principal has a grant and a denial.
      const rows = Array.from(dialog.querySelectorAll<HTMLElement>("li")).filter((item) => item.querySelector("[data-access-remove]"));
      expect(rows).toHaveLength(entries.length);
      const locked = entries
        .filter((_, index) => rows[index]!.querySelector<HTMLButtonElement>("[data-access-remove]")!.disabled)
        .map((item) => item.id);
      expect(locked).toEqual(scenario.locked);
    } finally {
      await closeDialog(dom);
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
}

for (const scopeType of ["base", "customApp"] as const) {
  domTest(`${scopeType} search offers people, groups, and active agents or standalone accounts`, async () => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    installPopoverApi(dom);
    const originalFetch = globalThis.fetch;
    const requests: URL[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        requests.push(new URL(input instanceof Request ? input.url : String(input), "http://cloud.test"));
        return Response.json({ items: [] });
      },
      { preconnect: originalFetch.preconnect },
    );
    const { ScopedAccessSection } = await import("./ScopedAccessSection");
    delegateEvents(["click", "input"], dom.document);
    const dispose = render(
      () => (
        <ScopedAccessSection
          scope={{ type: scopeType, id: "SCOPE01" }}
          resourceName="Projects"
          title="Access"
          initialEntries={[]}
          canEdit
        />
      ),
      dom.root,
    );
    try {
      const dialog = await openDialog(dom);
      const input = dialog.querySelector<HTMLInputElement>("input[role=combobox]")!;
      input.value = "helper";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(() => requests.length > 0, "scoped directory request");
      expect(requests[0]!.pathname).toBe("/api/accounts/entities");
      expect(requests[0]!.searchParams.get("kinds")).toBe("user,group,service_account");
      expect(requests[0]!.searchParams.get("service_account_status")).toBe("active");
      // Accounts of objects and apps are never found by name; the dialog adds them only by identifier.
      expect(requests[0]!.searchParams.get("service_account_kinds")).toBe("agent,standalone");
      // Only apps can be public.
      expect(!!dialog.querySelector('input[aria-label="Public with link"]')).toBe(scopeType === "customApp");
      if (scopeType === "customApp") {
        // A public app also accepts what it publishes, so the warning says so instead of promising read-only access.
        dialog.querySelector<HTMLInputElement>('input[aria-label="Public with link"]')!.click();
        await waitFor(() => dialog.textContent?.includes("send what it publishes, such as forms") === true, "the app's public warning");
        expect(dialog.textContent).not.toContain("Nobody can change anything without signing in.");
        // Off again, so closing has nothing to discard.
        dialog.querySelector<HTMLInputElement>('input[aria-label="Public with link"]')!.click();
        await waitFor(() => !dialog.textContent?.includes("send what it publishes"), "the public switch off");
      }
    } finally {
      await closeDialog(dom);
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
}
