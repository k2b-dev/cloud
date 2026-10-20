import { expect, test } from "bun:test";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

test("an old public entry explains that public links are off and keeps a fixed Use badge, while managers keep role choices", async () => {
  const dom = createDomTestHarness();
  const { StudioPermissions } = await import("./StudioPermissions");
  const dispose = render(
    () => (
      <StudioPermissions
        entries={[
          { id: "public", principal: { type: "public" }, permission: "read", createdAt: "2026-10-20T12:00:00.000Z" },
          {
            id: "owner",
            principal: { type: "user", userId: "owner" },
            permission: "admin",
            displayName: "Owner",
            createdAt: "2026-10-20T12:00:00.000Z",
          },
        ]}
        loadProjects={async () => [
          { projectId: "project", shortId: "project", name: "Finance team" },
          { projectId: "private", shortId: null, name: null },
        ]}
        grant={async () => null}
        change={async () => {}}
      />
    ),
    dom.root,
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dom.root.textContent).toContain("Access through projects");
    expect(dom.root.textContent).toContain("Finance team");
    expect(dom.root.textContent).toContain("Project without access to its details");
    // PUBLIC_APP_SHARING is off: the entry stays listed so managers can remove it, and opens nothing.
    expect(dom.root.textContent).toContain("Public links are switched off");
    expect(dom.root.textContent).toContain("cannot open this app for now");
    const rows = dom.root.querySelectorAll(".group\\/access-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Use");
    expect(rows[0]!.querySelector('[aria-label^="Permission"]')).toBeNull();
    expect(rows[1]!.textContent).toContain("Manage");
    expect(rows[1]!.querySelector('[aria-label^="Permission"]')).not.toBeNull();
  } finally {
    dispose();
    dom.cleanup();
  }
});

test("Studio keeps picked people and groups when grant responses omit names", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const { delegateEvents } = await import("solid-js/web");
  const { setSystemTime } = await import("bun:test");
  setSystemTime(new Date("2026-10-20T12:00:00.000Z"));
  const personId = "22222222-2222-4222-8222-222222222221";
  const groupId = "22222222-2222-4222-8222-222222222222";
  const prototype = dom.window.HTMLElement.prototype;
  const opened = new WeakSet<object>();
  const matches = prototype.matches;
  Object.assign(prototype, {
    matches(this: Element, selector: string) {
      return selector === ":popover-open" ? opened.has(this) : matches.call(this, selector);
    },
    showPopover(this: object) {
      opened.add(this);
    },
    hidePopover(this: object) {
      opened.delete(this);
    },
    scrollIntoView() {},
  });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return Response.json({
        items: url.searchParams.get("search")
          ? [
              { kind: "user", user: { id: personId, uid: "ada", displayName: "Ada Example", avatarHash: null, mail: null } },
              { kind: "group", group: { id: groupId, name: "Research team", description: null } },
            ]
          : [],
        pagination: { total: 0, has_next: false },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { StudioPermissions } = await import("./StudioPermissions");
  delegateEvents(["click", "input"], dom.document);
  let grants = 0;
  const dispose = render(
    () => (
      <StudioPermissions
        entries={[
          {
            id: "missing-user",
            principal: { type: "user", userId: "22222222-2222-4222-8222-222222222223" },
            permission: "admin",
            createdAt: "2026-10-20T12:00:00.000Z",
          },
          {
            id: "missing-group",
            principal: { type: "group", groupId: "22222222-2222-4222-8222-222222222224" },
            permission: "read",
            createdAt: "2026-10-20T12:00:00.000Z",
          },
        ]}
        loadProjects={async () => []}
        grant={async (principal, permission) => ({ id: `grant-${++grants}`, principal, permission, createdAt: "2026-10-20T12:00:00.000Z" })}
        change={async () => {}}
      />
    ),
    dom.root,
  );
  const waitFor = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (condition()) return;
      await Bun.sleep(10);
    }
    throw new Error("Studio grant did not settle");
  };
  try {
    expect(dom.root.textContent).toContain("Unknown person");
    expect(dom.root.textContent).toContain("Deleted group");
    for (const name of ["Ada Example", "Research team"]) {
      const input = dom.root.querySelector<HTMLInputElement>("input[role=combobox]")!;
      input.value = name.slice(0, 3);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(() => Array.from(dom.root.querySelectorAll("[role=option]")).some((option) => option.textContent?.includes(name)));
      Array.from(dom.root.querySelectorAll<HTMLButtonElement>("[role=option]"))
        .find((option) => option.textContent?.includes(name))!
        .click();
      await waitFor(() => !dom.root.querySelector('[aria-busy="true"]'));
      expect(dom.root.textContent).toContain(name);
    }
    expect(grants).toBe(2);
    expect(dom.root.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    for (const element of dom.root.querySelectorAll("[aria-label], [aria-description], [title]")) {
      for (const attribute of ["aria-label", "aria-description", "title"])
        expect(element.getAttribute(attribute) ?? "").not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    setSystemTime();
    dom.cleanup();
  }
});
