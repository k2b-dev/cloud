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
          { id: "public", principal: { type: "public" }, permission: "read", createdAt: new Date().toISOString() },
          {
            id: "owner",
            principal: { type: "user", userId: "owner" },
            permission: "admin",
            displayName: "Owner",
            createdAt: new Date().toISOString(),
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
