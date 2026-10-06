import { describe, expect, test } from "bun:test";
import type { AccessEntry } from "@k2b/cloud/contracts";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import type { Notebook } from "../sidebar/types";

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

describe("Notebook access settings", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const renderSection = async (entries: AccessEntry[]) => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => Response.json(entries), { preconnect: originalFetch.preconnect });
    const { PermissionsSection } = await import("./AccessSection");
    const dispose = render(() => <PermissionsSection notebook={notebook} />, dom.root);
    const rowElements = () => Array.from(dom.root.querySelectorAll<HTMLElement>(".group\\/access-row"));
    // Each row's name and, for a service account, its kind label.
    const rows = () =>
      rowElements().map((row) =>
        Array.from(row.querySelectorAll(".min-w-0 > span"))
          .map((span) => span.textContent)
          .join(" "),
      );
    for (let attempt = 0; attempt < 200 && rowElements().length === 0; attempt += 1) await Bun.sleep(10);
    const removeButton = (name: string) => dom.root.querySelector<HTMLButtonElement>(`button[aria-label="Remove ${name}"]`);
    return {
      rows,
      removeButton,
      cleanup: () => {
        dispose();
        globalThis.fetch = originalFetch;
        dom.cleanup();
      },
    };
  };

  test("shows an agent that manages the notebook, so a person managing next to it is not locked", async () => {
    const section = await renderSection([person, agent, apiKey]);
    try {
      expect(section.rows()).toEqual(["Ada Lovelace", "Research agent (Agent)"]);
      expect(section.removeButton("Ada Lovelace")?.disabled).toBe(false);
      expect(section.removeButton("Research agent")?.disabled).toBe(false);
    } finally {
      section.cleanup();
    }
  });

  test("keeps API keys in their own section and does not count them as managers", async () => {
    const section = await renderSection([person, apiKey]);
    try {
      expect(section.rows()).toEqual(["Ada Lovelace"]);
      expect(section.removeButton("Ada Lovelace")?.disabled).toBe(true);
    } finally {
      section.cleanup();
    }
  });
});
