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
const ben = entry("3", "Ben Albers", "read");

const handle = "code-7k2q9m4xwt";
const codeAccountId = "20000000-0000-4000-8000-000000000001";
const calls: string[] = [];
const state: {
  projectsFail: boolean;
  deleteFails: boolean;
  entries: AccessEntry[];
  /** Holds the next answer of the access list or the projects until the test lets it through. */
  accessHeld: PromiseWithResolvers<void> | null;
  projectsHeld: PromiseWithResolvers<void> | null;
} = { projectsFail: false, deleteFails: false, entries: [mia, lea], accessHeld: null, projectsHeld: null };
/** One resource's access routes, as the core client exposes them for Skills and Projects. */
const accessRoutes = (kind: string) => ({
  access: {
    $get: async () => {
      await state.accessHeld?.promise;
      return Response.json({ access: state.entries });
    },
    $post: async ({ json }: { json: { principal: AccessEntry["principal"]; permission: AccessEntry["permission"] } }) => {
      calls.push(`${kind} POST ${JSON.stringify(json)}`);
      return Response.json({ access: { ...lea, ...json, displayName: "Code von Werkstatt", serviceAccountKind: "code" } });
    },
    ":accessId": {
      $patch: async ({ param, json }: { param: { accessId: string }; json: { permission: string } }) => {
        calls.push(`${kind} PATCH ${param.accessId.slice(-1)} ${json.permission}`);
        return Response.json({});
      },
      $delete: async ({ param }: { param: { accessId: string } }) => {
        calls.push(`${kind} DELETE ${param.accessId.slice(-1)}`);
        return state.deleteFails ? Response.json({ message: "offline" }, { status: 503 }) : Response.json({});
      },
    },
  },
});
if (!isServer) {
  mock.module("@k2b/cloud/clients/core", () => ({
    coreClient: {
      accounts: {
        entities: {
          $get: async ({ query }: { query: Record<string, string> }, options: { init: { signal: AbortSignal } }) => {
            expect(options.init.signal).toBeInstanceOf(AbortSignal);
            expect(query).toMatchObject({ kinds: "service_account", service_account_kinds: "code" });
            // The platform rejects names before transport; the dialog supplies the lookup target.
            expect(query.search).toBe(handle);
            calls.push(`lookup ${query.target_type} ${query.target_id} ${query.search}`);
            return Response.json({
              items:
                query.search === handle
                  ? [
                      {
                        kind: "service_account",
                        serviceAccount: {
                          id: codeAccountId,
                          kind: "code",
                          handle,
                          name: "Code von Werkstatt",
                          status: "active",
                        },
                      },
                    ]
                  : [],
            });
          },
        },
      },
      admin: {
        core: {
          "ai-skills": {
            ":skillId": {
              ...accessRoutes("skill"),
              projects: {
                $get: async () => {
                  await state.projectsHeld?.promise;
                  return state.projectsFail
                    ? Response.json({ message: "offline" }, { status: 503 })
                    : Response.json({ projects: [{ id: "p1", name: "Support desk" }] });
                },
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
    state.deleteFails = false;
    state.entries = [mia, lea];
    state.accessHeld = null;
    state.projectsHeld = null;
  });

  const setup = async (kind: "skill" | "project", options: { waitForDialog?: boolean } = {}) => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    installPopoverApi(dom);
    delegateEvents(["click", "input"], dom.document);
    const refreshed = spyOn(navigation, "refreshCurrentPath").mockImplementation(() => {});
    const { prompts } = await import("@k2b/ui");
    const error = spyOn(prompts, "error").mockResolvedValue(undefined);
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    const disposeRender =
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
    /** By accessible name: a button with a short label on phones keeps its full name. */
    const button = (text: string) =>
      Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find(
        (item) => item.getAttribute("aria-label") === text || item.textContent?.trim() === text,
      );
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      disposeRender();
    };
    cleanup = async () => {
      if (dialog()) {
        button("Cancel")?.click();
        await until(() => !dialog());
      }
      dispose();
      refreshed.mockRestore();
      error.mockRestore();
      confirm.mockRestore();
      dom.cleanup();
    };
    if (options.waitForDialog !== false) await until(() => dialog()?.textContent?.includes("Lea Schmitt") === true);
    const row = (name: string) => Array.from(dialog()!.querySelectorAll("li")).find((item) => item.textContent?.includes(name))!;
    return { dom, dialog, button, row, refreshed, error, dispose };
  };

  for (const kind of ["skill", "project"] as const) {
    test(`${kind} finds by Kennung, adds a service-account row and saves its UUID`, async () => {
      const ui = await setup(kind);
      ui.button("Add service account")!.click();
      const input = ui.dialog()!.querySelector<HTMLInputElement>('input[aria-label="Identifier of the service account"]')!;
      // A name is never looked up; Enter says that no service account has this identifier.
      input.value = "Code von Werkstatt";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await until(() => ui.dialog()?.textContent?.includes("No service account with this identifier") === true);
      // A complete identifier is looked up as it is typed; its hit below the field adds the row.
      input.value = handle;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const hit = () =>
        Array.from(ui.dialog()!.querySelectorAll<HTMLButtonElement>("li button")).find((item) =>
          item.textContent?.includes("Code von Werkstatt"),
        );
      await until(() => !!hit());
      hit()!.click();
      await until(() => ui.dialog()?.textContent?.includes("1 change") === true);
      expect(ui.row("Code von Werkstatt").textContent).toContain("Service account");
      expect(ui.dialog()!.textContent).toContain("Whoever edits the code acts with this right.");
      expect(Array.from(ui.row("Code von Werkstatt").querySelectorAll('[role="option"]')).map((node) => node.textContent)).not.toContain(
        "Manage",
      );
      expect(calls).toEqual([`lookup core.ai.${kind} ${kind}-1 ${handle}`]);
      ui.button("Save")!.click();
      await until(() => !ui.dialog());
      expect(calls.at(-1)).toBe(
        `${kind} POST ${JSON.stringify({ principal: { type: "service_account", serviceAccountId: codeAccountId }, permission: "write" })}`,
      );
      expect(ui.refreshed).toHaveBeenCalledTimes(1);
    });
  }

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

  test("a Skill opens before its projects answer, and failed projects can be loaded again", async () => {
    state.projectsHeld = Promise.withResolvers<void>();
    state.projectsFail = true;
    const held = state.projectsHeld;
    const ui = await setup("skill");
    expect(ui.dialog()!.textContent).toContain("Loading the projects that include this Skill");
    held.resolve();
    await until(() => ui.dialog()?.textContent?.includes("Could not load the projects that include this Skill.") === true);
    state.projectsHeld = null;
    state.projectsFail = false;
    Array.from(ui.dialog()!.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Retry")!
      .click();
    await until(() => ui.dialog()?.textContent?.includes("Support desk") === true);
  });

  test("a save that fails halfway and is discarded still refreshes the page", async () => {
    state.entries = [mia, lea, ben];
    state.deleteFails = true;
    const ui = await setup("skill");
    Array.from(ui.row("Lea Schmitt").querySelectorAll<HTMLElement>('[role="option"]'))
      .find((option) => option.textContent?.includes("Edit"))!
      .click();
    ui.row("Ben Albers").querySelector<HTMLButtonElement>('button[aria-label="Remove Ben Albers"]')!.click();
    await until(() => ui.dialog()?.textContent?.includes("2 changes") === true);
    ui.button("Save")!.click();
    await until(() => !!ui.dialog()?.querySelector('[role="alert"]'));
    expect(calls).toEqual(["skill PATCH 2 write", "skill DELETE 3"]);
    ui.button("Cancel")!.click();
    await until(() => !ui.dialog());
    expect(ui.refreshed).toHaveBeenCalledTimes(1);
  });

  test("a page that changes while the list loads gets no dialog and no error", async () => {
    state.accessHeld = Promise.withResolvers<void>();
    const held = state.accessHeld;
    const ui = await setup("project", { waitForDialog: false });
    ui.dispose();
    held.resolve();
    await Bun.sleep(30);
    expect(ui.dialog()).toBeNull();
    expect(ui.error).not.toHaveBeenCalled();
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
