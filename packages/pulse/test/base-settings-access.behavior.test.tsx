import { describe, expect, mock, spyOn, test } from "bun:test";
import type { AccessEntry } from "@k2b/cloud/contracts";
import { delegateEvents, isServer } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { PulseBase } from "../src/contracts";

/** Opens a row's level menu and picks a level, as a person would. */
const chooseLevel = (row: Element, level: string) => {
  row.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click();
  Array.from(row.querySelectorAll<HTMLElement>('[role="radio"]'))
    .find((option) => option.textContent?.includes(level))!
    .click();
};

const base: PulseBase = {
  id: "base-1",
  shortId: "base-1",
  icon: "ti ti-chart-line",
  color: "blue",
  timezone: "UTC",
  name: "Shop metrics",
  description: null,
  rawRetentionDays: 30,
  rollupRetentionDays: 365,
  sensitiveRetentionHours: 24,
  createdBy: null,
  deletionStartedAt: null,
  deletionFailedAt: null,
  deletionError: null,
  dataClearStartedAt: null,
  dataClearCompletedAt: null,
  dataClearFailedAt: null,
  dataClearError: null,
  memberCount: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  store: {
    state: "active",
    operation: null,
    errorCode: null,
    errorAt: null,
    writeBlockReason: null,
    profile: "normal",
    limits: {
      queriesPerHour: 600,
      valuesPerMinute: 2000,
      bytesPerMinute: 5_242_880,
      storageBytes: 5_000_000_000,
      maxSeries: 50_000,
      maxEventKinds: 2000,
      maxStateKeys: 2000,
    },
    usage: null,
  },
};

const entry = (id: string, name: string, permission: AccessEntry["permission"]): AccessEntry => ({
  id,
  principal: { type: "user", userId: `user-${id}` },
  permission,
  displayName: name,
  createdAt: "2026-01-01T00:00:00.000Z",
});
const mia = entry("mia", "Mia Hoffmann", "admin");
const lea = entry("lea", "Lea Schmitt", "read");
const ben = entry("ben", "Ben Albers", "read");

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

describe("Pulse base settings: access", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const setup = async () => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    delegateEvents(["click", "input"], dom.document);
    const { prompts } = await import("@k2b/ui");
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    const state = { stored: [mia, lea, ben], reads: 0 };
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = init?.method ?? "GET";
        if (!url.includes("/access")) return Response.json({});
        const accessId = url.split("/access/")[1];
        if (method === "GET") {
          state.reads += 1;
          return Response.json(state.stored);
        }
        calls.push(`${method} ${accessId}`);
        if (method === "DELETE") return Response.json({ message: "offline" }, { status: 503 });
        const { permission } = JSON.parse(String(init?.body)) as { permission: AccessEntry["permission"] };
        state.stored = state.stored.map((item) => (item.id === accessId ? { ...item, permission } : item));
        return new Response(null, { status: 204 });
      },
      { preconnect: originalFetch.preconnect },
    );
    const refreshBase = mock(async () => {});
    const owner = new AbortController();
    let requestClose: (() => Promise<boolean>) | undefined;
    const { openPulseBaseSettingsDialog } = await import("../src/frontend/workspace/base-settings-dialog");
    const closed = openPulseBaseSettingsDialog({
      base,
      canAdmin: true,
      admins: [],
      maxRawRetentionDays: 400,
      initialTab: "members",
      signal: owner.signal,
      onCloseRequestReady: (request) => {
        requestClose = request;
      },
      loading: () => false,
      refreshBase,
      updateBaseSettings: async () => "persisted",
      writeBlocked: () => false,
      currentStore: () => null,
      retryStore: async () => null,
      clearBaseData: async () => {},
      deleteBase: async () => false,
    });
    const button = (text: string) =>
      Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === text);
    // The settings and the access dialog share one dialog element; the access panel is the visible top layer.
    const panel = () =>
      Array.from(dom.document.querySelectorAll<HTMLElement>("dialog > *")).find(
        (item) => item.style.display !== "none" && item.textContent?.includes("Access to Shop metrics"),
      );
    const row = (name: string) => Array.from(panel()!.querySelectorAll("li")).find((item) => item.textContent?.includes(name))!;
    const openAccess = async () => {
      await waitFor(() => !!button("Edit access") && !button("Edit access")!.disabled, "the access list");
      button("Edit access")!.click();
      await waitFor(() => panel()?.textContent?.includes("Ben Albers") === true, "the access dialog");
    };
    const stageTwoChanges = async () => {
      chooseLevel(row("Lea Schmitt"), "Edit");
      row("Ben Albers").querySelector<HTMLButtonElement>('button[aria-label="Remove Ben Albers"]')!.click();
      await waitFor(() => panel()?.textContent?.includes("2 changes") === true, "two changes");
    };
    return {
      dom,
      state,
      calls,
      refreshBase,
      owner,
      closed,
      requestClose: () => requestClose!(),
      button,
      panel,
      openAccess,
      stageTwoChanges,
      cleanup: async () => {
        owner.abort();
        await closed;
        confirm.mockRestore();
        globalThis.fetch = originalFetch;
        dom.cleanup();
      },
    };
  };

  test("changes save together in the access dialog; a half-failed, discarded save still reloads the list once", async () => {
    const ui = await setup();
    try {
      await ui.openAccess();
      expect(ui.button("Remove Lea Schmitt")).toBeUndefined();
      await ui.stageTwoChanges();
      expect(ui.calls).toEqual([]);
      const readsBefore = ui.state.reads;
      ui.button("Save")!.click();
      await waitFor(() => !!ui.panel()?.querySelector('[role="alert"]'), "the failed removal");
      expect(ui.calls).toEqual(["PATCH lea", "DELETE ben"]);
      // Saving does not reload after each change.
      expect(ui.state.reads).toBe(readsBefore);
      ui.button("Cancel")!.click();
      await waitFor(() => !ui.panel(), "the access dialog to close");
      await waitFor(() => ui.state.reads === readsBefore + 1 && ui.refreshBase.mock.calls.length === 1, "one reload after the dialog");
    } finally {
      await ui.cleanup();
    }
  });

  test("Back while the access dialog is open keeps both open with the staged changes", async () => {
    const ui = await setup();
    try {
      await ui.openAccess();
      await ui.stageTwoChanges();
      expect(await ui.requestClose()).toBe(false);
      expect(ui.panel()?.textContent).toContain("2 changes");
      expect(ui.calls).toEqual([]);
    } finally {
      await ui.cleanup();
    }
  });

  test("settings closed by their owner take the access dialog along, and nothing more is sent", async () => {
    const ui = await setup();
    try {
      await ui.openAccess();
      await ui.stageTwoChanges();
      ui.owner.abort();
      await ui.closed;
      await waitFor(() => !ui.panel(), "the access dialog to close");
      expect(ui.dom.document.querySelector("dialog[open]")).toBeNull();
      await Bun.sleep(20);
      expect(ui.calls).toEqual([]);
    } finally {
      await ui.cleanup();
    }
  });
});
