import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AccessEntry } from "@k2b/cloud/contracts";
import * as navigation from "@k2b/ssr/nav";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../ui/test/dom";

const entry = (id: string, name: string, permission: AccessEntry["permission"]): AccessEntry => ({
  id: `00000000-0000-4000-8000-00000000000${id}`,
  principal: { type: "user", userId: `10000000-0000-4000-8000-00000000000${id}` },
  permission,
  createdAt: "2026-11-04T00:00:00.000Z",
  displayName: name,
});
const mia = entry("1", "Mia Hoffmann", "admin");
const lea = entry("2", "Lea Schmitt", "read");

const calls: string[] = [];
const state = { projectsFail: false, entries: [mia, lea] };
/** One resource's access routes, as the core client exposes them for Skills and Projects. */
const accessRoutes = (kind: string) => ({
  access: {
    $get: async () => Response.json({ access: state.entries }),
    $post: async () => Response.json({ access: lea }),
    ":accessId": {
      $patch: async ({ param, json }: { param: { accessId: string }; json: { permission: string } }) => {
        calls.push(`${kind} PATCH ${param.accessId.slice(-1)} ${json.permission}`);
        return Response.json({});
      },
      $delete: async ({ param }: { param: { accessId: string } }) => {
        calls.push(`${kind} DELETE ${param.accessId.slice(-1)}`);
        return Response.json({});
      },
    },
  },
});
if (!isServer) {
  mock.module("@k2b/cloud/clients/core", () => ({
    coreClient: {
      admin: {
        core: {
          "ai-skills": {
            ":skillId": {
              ...accessRoutes("skill"),
              projects: {
                $get: async () =>
                  state.projectsFail
                    ? Response.json({ message: "offline" }, { status: 503 })
                    : Response.json({ projects: [{ id: "p1", name: "Support desk" }] }),
              },
            },
          },
          "ai-projects": { ":projectId": accessRoutes("project") },
        },
      },
    },
  }));
}

/** happy-dom has no Popover API; the actions menu opens through it. */
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
    togglePopover(this: object) {
      if (open.has(this)) open.delete(this);
      else open.add(this);
    },
    scrollIntoView() {},
  });
};

/** Waits for the condition; the test's own timeout bounds it. */
const until = async (condition: () => boolean) => {
  while (!condition()) await Bun.sleep(10);
};

describe("AI administration access", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }
  let cleanup = async () => {};
  afterEach(async () => {
    await cleanup();
    calls.length = 0;
    state.projectsFail = false;
  });

  const setup = async (kind: "skill" | "project") => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    installPopoverApi(dom);
    delegateEvents(["click", "input"], dom.document);
    const refreshed = spyOn(navigation, "refreshCurrentPath").mockImplementation(() => {});
    const dispose =
      kind === "skill"
        ? await import("../src/pages/admin/settings/_components/AiSkillAdminActions.island").then(({ default: Actions }) =>
            render(() => <Actions skillId="skill-1" skillName="Triage" revision={1} source={null} />, dom.root),
          )
        : await import("../src/pages/admin/settings/_components/AiProjectAdminActions.island").then(({ default: Actions }) =>
            render(() => <Actions projectId="project-1" projectName="Support desk" />, dom.root),
          );
    dom.root.querySelector<HTMLButtonElement>("button[aria-label^='Actions for']")!.click();
    Array.from(dom.document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((node) => node.textContent?.includes("Permissions"))!
      .click();
    const dialog = () => dom.document.querySelector<HTMLElement>('[role="dialog"]');
    const button = (text: string) =>
      Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === text);
    cleanup = async () => {
      if (dialog()) {
        button("Cancel")?.click();
        await until(() => !dialog());
      }
      dispose();
      refreshed.mockRestore();
      dom.cleanup();
    };
    await until(() => dialog()?.textContent?.includes("Lea Schmitt") === true);
    return { dom, dialog, button, refreshed };
  };

  test("a Skill's dialog names the projects that include it and saves a change on Save", async () => {
    const ui = await setup("skill");
    expect(ui.dialog()!.textContent).toContain("Access through projects");
    expect(ui.dialog()!.textContent).toContain("Support desk");
    const row = Array.from(ui.dialog()!.querySelectorAll("li")).find((item) => item.textContent?.includes("Lea Schmitt"))!;
    Array.from(row.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((option) => option.textContent?.includes("Edit"))!
      .click();
    await until(() => ui.dialog()?.textContent?.includes("1 change") === true);
    expect(calls).toEqual([]);
    ui.button("Save")!.click();
    await until(() => !ui.dialog());
    expect(calls).toEqual(["skill PATCH 2 write"]);
    expect(ui.refreshed).toHaveBeenCalledTimes(1);
  });

  test("a Skill whose projects cannot load still opens for its direct access", async () => {
    state.projectsFail = true;
    const ui = await setup("skill");
    expect(ui.dialog()!.textContent).toContain("Could not load the projects that include this Skill.");
  });

  test("a Project's dialog refreshes nothing when it closes unchanged", async () => {
    const ui = await setup("project");
    ui.button("Cancel")!.click();
    await until(() => !ui.dialog());
    await Bun.sleep(20);
    expect(calls).toEqual([]);
    expect(ui.refreshed).not.toHaveBeenCalled();
  });
});
