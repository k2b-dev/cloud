import { describe, expect, spyOn, test } from "bun:test";
import type { AccessEntry } from "@k2b/cloud/contracts";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import type { Notebook } from "../sidebar/types";

/** Opens a row's level menu and picks a level, as a person would. */
const chooseLevel = (row: Element, level: string) => {
  row.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click();
  Array.from(row.querySelectorAll<HTMLElement>('[role="radio"]'))
    .find((option) => option.textContent?.includes(level))!
    .click();
};

const notebook: Notebook = {
  id: "notes1",
  name: "Research",
  description: null,
  icon: "ti ti-flask",
  homepageNoteId: null,
  defaultPresentationMode: "write",
  noteDeletePermission: "write",
  defaultNoteTitleTemplate: "{{ date }}",
  createdBy: "user-id",
  createdAt: "2026-08-10T10:00:00.000Z",
  updatedAt: "2026-08-10T10:00:00.000Z",
};

const manager = (id: string, principal: AccessEntry["principal"], displayName: string, extra: Partial<AccessEntry> = {}): AccessEntry => ({
  id,
  principal,
  permission: "admin",
  displayName,
  createdAt: "2026-08-10T10:00:00.000Z",
  ...extra,
});
const person = manager("access-person", { type: "user", userId: "user-1" }, "Ada Lovelace");
const agent = manager("access-agent", { type: "service_account", serviceAccountId: "agent-1" }, "Research agent", {
  serviceAccountKind: "agent",
});
const apiKey = manager("access-key", { type: "service_account", serviceAccountId: "key-1" }, "Research API keys", {
  serviceAccountKind: "resource_bound",
});

const lea = manager("access-lea", { type: "user", userId: "user-2" }, "Lea Schmitt", { permission: "read" });
const ben = manager("access-ben", { type: "user", userId: "user-3" }, "Ben Albers", { permission: "read" });

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

describe("Notebook access settings", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const renderSection = async (entries: AccessEntry[]) => {
    let stored = entries;
    const calls: string[] = [];
    // Set to hold the next list read until the test lets it answer.
    const reads: { held: PromiseWithResolvers<void> | null } = { held: null };
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    delegateEvents(["click", "input"], dom.document);
    const { prompts } = await import("@k2b/ui");
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const accessId = String(input).split("/access/")[1];
        if (method === "GET") {
          const held = reads.held;
          if (held) await held.promise;
          return Response.json(stored);
        }
        calls.push(`${method} ${accessId}`);
        if (method === "DELETE" && accessId === ben.id) return Response.json({ message: "Offline" }, { status: 503 });
        if (method === "DELETE") stored = stored.filter((entry) => entry.id !== accessId);
        if (method === "PATCH") {
          const { permission } = JSON.parse(String(init?.body)) as { permission: AccessEntry["permission"] };
          stored = stored.map((entry) => (entry.id === accessId ? { ...entry, permission } : entry));
        }
        return Response.json({});
      },
      { preconnect: originalFetch.preconnect },
    );
    const { PermissionsSection } = await import("./AccessSection");
    const dispose = render(() => <PermissionsSection notebook={notebook} />, dom.root);
    // The summary's list of who has access: each row's name and, for a service account, its kind.
    const rowElements = () => Array.from(dom.root.querySelectorAll<HTMLElement>(".k2b-avatar-stack__row"));
    const rows = () =>
      rowElements().map((row) =>
        Array.from(row.querySelectorAll(".k2b-avatar-stack__row-name > span"))
          .map((span) => span.textContent)
          .join(" "),
      );
    await waitFor(() => rowElements().length > 0, "the access summary");
    const button = (text: string) =>
      Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === text);
    const dialog = () => dom.document.querySelector<HTMLElement>('[role="dialog"]:not(.k2b-avatar-stack__popover)');
    const row = (name: string) => Array.from(dialog()!.querySelectorAll("li")).find((item) => item.textContent?.includes(name))!;
    return {
      dom,
      calls,
      reads,
      rows,
      button,
      dialog,
      row,
      cleanup: () => {
        dispose();
        confirm.mockRestore();
        globalThis.fetch = originalFetch;
        dom.cleanup();
      },
    };
  };

  test("sums up who may use the notebook, agents included, without controls and without API keys", async () => {
    const section = await renderSection([person, agent, apiKey]);
    try {
      expect(section.rows()).toEqual(["Ada Lovelace", "Research agent Agent"]);
      expect(section.dom.root.textContent).toContain("2 people, groups and agents · All signed-in people: off");
      expect(section.dom.root.querySelector('button[aria-label="Remove Ada Lovelace"]')).toBeNull();
      section.button("Edit access")!.click();
      await waitFor(() => section.dialog()?.textContent?.includes("Research agent") === true, "the access dialog");
      expect(section.dialog()!.textContent).not.toContain("Research API keys");
      section.button("Cancel")!.click();
      await waitFor(() => !section.dialog(), "the unchanged dialog to close");
    } finally {
      section.cleanup();
    }
  });

  test("a save that fails halfway and is discarded still shows what was saved", async () => {
    const section = await renderSection([person, lea, ben]);
    try {
      section.button("Edit access")!.click();
      await waitFor(() => section.dialog()?.textContent?.includes("Ben Albers") === true, "the access dialog");
      chooseLevel(section.row("Lea Schmitt"), "Edit");
      section.row("Ben Albers").querySelector<HTMLButtonElement>('button[aria-label="Remove Ben Albers"]')!.click();
      await waitFor(() => section.dialog()?.textContent?.includes("2 changes") === true, "two changes");
      section.button("Save")!.click();
      await waitFor(() => !!section.dialog()?.querySelector('[role="alert"]'), "the failed removal");
      expect(section.calls).toEqual([`PATCH ${lea.id}`, `DELETE ${ben.id}`]);
      section.button("Cancel")!.click();
      await waitFor(() => !section.dialog(), "the dialog to close");
      await waitFor(
        () => section.dom.root.textContent?.replace("Edit access", "").includes("Edit") === true,
        "the list to show Lea's new level",
      );
      expect(section.rows()).toEqual(["Ada Lovelace", "Lea Schmitt", "Ben Albers"]);
    } finally {
      section.cleanup();
    }
  });

  test("Edit access during the reload after a save waits for the saved list", async () => {
    const section = await renderSection([person, lea]);
    try {
      section.button("Edit access")!.click();
      await waitFor(() => section.dialog()?.textContent?.includes("Lea Schmitt") === true, "the access dialog");
      chooseLevel(section.row("Lea Schmitt"), "Edit");
      section.reads.held = Promise.withResolvers<void>();
      const held = section.reads.held;
      section.button("Save")!.click();
      await waitFor(() => !section.dialog(), "the dialog to close");
      section.button("Edit access")!.click();
      await Bun.sleep(50);
      expect(section.dialog()).toBeNull();
      section.reads.held = null;
      held.resolve();
      await waitFor(
        () => section.dom.root.textContent?.replace("Edit access", "").includes("Edit") === true,
        "the list to show Lea's new level",
      );
      section.button("Edit access")!.click();
      await waitFor(() => !!section.dialog(), "the access dialog with the saved list");
      expect(section.dialog()!.textContent).not.toContain("before");
      expect(section.row("Lea Schmitt").querySelector('button[aria-haspopup="dialog"]')?.textContent).toContain("Edit");
      section.button("Cancel")!.click();
      await waitFor(() => !section.dialog(), "the unchanged dialog to close");
    } finally {
      section.cleanup();
    }
  });
});
