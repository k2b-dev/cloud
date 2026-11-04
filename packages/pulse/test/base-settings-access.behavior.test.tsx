import { describe, expect, mock, spyOn, test } from "bun:test";
import type { AccessEntry } from "@k2b/cloud/contracts";
import { delegateEvents, isServer } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { PulseBase } from "../src/contracts";

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

  test("changes save together in the access dialog; a half-failed, discarded save still reloads the list once", async () => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    delegateEvents(["click", "input"], dom.document);
    const { prompts } = await import("@k2b/ui");
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    let stored = [mia, lea, ben];
    const calls: string[] = [];
    let reads = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = init?.method ?? "GET";
        if (!url.includes("/access")) return Response.json({});
        const accessId = url.split("/access/")[1];
        if (method === "GET") {
          reads += 1;
          return Response.json(stored);
        }
        calls.push(`${method} ${accessId}`);
        if (method === "DELETE") return Response.json({ message: "offline" }, { status: 503 });
        const { permission } = JSON.parse(String(init?.body)) as { permission: AccessEntry["permission"] };
        stored = stored.map((item) => (item.id === accessId ? { ...item, permission } : item));
        return new Response(null, { status: 204 });
      },
      { preconnect: originalFetch.preconnect },
    );
    const refreshBase = mock(async () => {});
    const { openPulseBaseSettingsDialog } = await import("../src/frontend/workspace/base-settings-dialog");
    void openPulseBaseSettingsDialog({
      base,
      canAdmin: true,
      admins: [],
      maxRawRetentionDays: 400,
      initialTab: "members",
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
    try {
      await waitFor(() => !!button("Edit access") && !button("Edit access")!.disabled, "the access list");
      expect(button("Remove Lea Schmitt")).toBeUndefined();
      button("Edit access")!.click();
      await waitFor(() => panel()?.textContent?.includes("Ben Albers") === true, "the access dialog");
      Array.from(row("Lea Schmitt").querySelectorAll<HTMLElement>('[role="option"]'))
        .find((option) => option.textContent?.includes("Edit"))!
        .click();
      row("Ben Albers").querySelector<HTMLButtonElement>('button[aria-label="Remove Ben Albers"]')!.click();
      await waitFor(() => panel()?.textContent?.includes("2 changes") === true, "two changes");
      expect(calls).toEqual([]);
      const readsBefore = reads;
      button("Save")!.click();
      await waitFor(() => !!panel()?.querySelector('[role="alert"]'), "the failed removal");
      expect(calls).toEqual(["PATCH lea", "DELETE ben"]);
      // Saving does not reload after each change.
      expect(reads).toBe(readsBefore);
      button("Cancel")!.click();
      await waitFor(() => !panel(), "the access dialog to close");
      await waitFor(() => reads === readsBefore + 1 && refreshBase.mock.calls.length === 1, "one reload after the dialog");
    } finally {
      confirm.mockRestore();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
});
